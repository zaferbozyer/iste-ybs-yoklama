// db.js — Test için JSON dosya tabanlı basit veritabanı
// Gerçek üretimde PostgreSQL/MySQL kullanılmalı

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'data.json');

// Başlangıç verisi
const initialData = {
    users: [
        {
            id: 'user-1',
            username: 'zafer.bozyer',
            // Şifre: "akademisyen123"
            password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LPVImber0/e',
            fullName: 'Prof. Dr. Zafer Bozyer',
            role: 'lecturer'
        }
    ],
    courses: [
        {
            id: 'course-1',
            code: 'BIL301',
            name: 'Yazılım Mühendisliği',
            lecturerId: 'user-1'
        },
        {
            id: 'course-2',
            code: 'BIL401',
            name: 'Yapay Zeka ve Makine Öğrenmesi',
            lecturerId: 'user-1'
        }
    ],
    students: [
        // BIL301 öğrencileri
        { id: 'std-1', studentNo: '2021001', fullName: 'Ali Yılmaz',    tcNo: '12345678901', courseId: 'course-1' },
        { id: 'std-2', studentNo: '2021002', fullName: 'Ayşe Kaya',     tcNo: '23456789012', courseId: 'course-1' },
        { id: 'std-3', studentNo: '2021003', fullName: 'Mehmet Demir',  tcNo: '34567890123', courseId: 'course-1' },
        { id: 'std-4', studentNo: '2021004', fullName: 'Zeynep Arslan', tcNo: '45678901234', courseId: 'course-1' },
        { id: 'std-5', studentNo: '2021005', fullName: 'Can Öztürk',    tcNo: '56789012345', courseId: 'course-1' },
        // BIL401 öğrencileri
        { id: 'std-6', studentNo: '2020001', fullName: 'Selin Çelik',   tcNo: '67890123456', courseId: 'course-2' },
        { id: 'std-7', studentNo: '2020002', fullName: 'Burak Şahin',   tcNo: '78901234567', courseId: 'course-2' },
        { id: 'std-8', studentNo: '2020003', fullName: 'Merve Yıldız',  tcNo: '89012345678', courseId: 'course-2' },
        { id: 'std-9', studentNo: '2020004', fullName: 'Emre Kılıç',    tcNo: '90123456789', courseId: 'course-2' },
        { id: 'std-10', studentNo: '2020005', fullName: 'Hande Aydın',  tcNo: '01234567890', courseId: 'course-2' }
    ],
    sessions: [],       // Aktif/geçmiş yoklama oturumları
    attendances: []     // Yoklama kayıtları
};

// DB'yi yükle veya oluştur
function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

// DB'yi kaydet
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Kullanıcı işlemleri ──────────────────────────────────

function findUserByUsername(username) {
    const db = loadDB();
    return db.users.find(u => u.username === username) || null;
}

// ── Ders işlemleri ───────────────────────────────────────

function getCoursesByLecturer(lecturerId) {
    const db = loadDB();
    return db.courses.filter(c => c.lecturerId === lecturerId);
}

function getCourseById(courseId) {
    const db = loadDB();
    return db.courses.find(c => c.id === courseId) || null;
}

// ── Öğrenci işlemleri ────────────────────────────────────

function getStudentsByCourse(courseId) {
    const db = loadDB();
    return db.students.filter(s => s.courseId === courseId);
}

function getStudentByTcNo(tcNo) {
    const db = loadDB();
    return db.students.find(s => s.tcNo === tcNo) || null;
}

// ── Oturum işlemleri ─────────────────────────────────────

function createSession(courseId, lecturerId) {
    const db = loadDB();
    const session = {
        id: require('uuid').v4(),
        courseId,
        lecturerId,
        yoklamaKodu: require('uuid').v4(),
        createdAt: new Date().toISOString(),
        status: 'active',    // active | finalized
        suiTxHash: null
    };
    db.sessions.push(session);
    saveDB(db);
    return session;
}

function getSessionById(sessionId) {
    const db = loadDB();
    return db.sessions.find(s => s.id === sessionId) || null;
}

function finalizeSession(sessionId, suiTxHash) {
    const db = loadDB();
    const session = db.sessions.find(s => s.id === sessionId);
    if (session) {
        session.status = 'finalized';
        session.suiTxHash = suiTxHash;
        session.finalizedAt = new Date().toISOString();
        saveDB(db);
    }
    return session;
}

function getActiveSessionsByCourse(courseId) {
    const db = loadDB();
    return db.sessions.filter(s => s.courseId === courseId && s.status === 'active');
}

// ── Yoklama işlemleri ─────────────────────────────────────

/**
 * Öğrenci "Yoklamaya Katıl" bastığında:
 * 1. Portal hash = SHA256(tc_no + yoklama_kodu) üretir
 * 2. Bu kaydı DB'ye ekler
 * 3. yoklama_kodu'nu öğrenciye verir (APK bunu kullanacak)
 */
function studentJoinSession(sessionId, studentId, deviceId) {
    const db = loadDB();
    const session = db.sessions.find(s => s.id === sessionId);
    const student = db.students.find(s => s.id === studentId);

    if (!session || !student) return null;

    // Portal kendi hash'ini üretir
    const portalHash = crypto
        .createHash('sha256')
        .update(student.tcNo + session.yoklamaKodu)
        .digest('hex');

    const bleToken = portalHash.substring(0, 16);

    // Daha önce katıldıysa güncelle
    const existing = db.attendances.find(
        a => a.sessionId === sessionId && a.studentId === studentId
    );

    if (existing) {
        existing.deviceId = deviceId;
        existing.portalJoinedAt = new Date().toISOString();
        existing.bleVerified = false;
    } else {
        db.attendances.push({
            id: require('uuid').v4(),
            sessionId,
            studentId,
            studentName: student.fullName,
            portalHash,
            bleToken,
            deviceId,
            portalJoinedAt: new Date().toISOString(),
            bleVerifiedAt: null,
            bleVerified: false,
            suiHash: null
        });
    }

    saveDB(db);
    return { yoklamaKodu: session.yoklamaKodu, bleToken };
}

/**
 * Akademisyen BLE token listesi gönderdiğinde:
 * Hangi öğrencilerin sınıfta olduğunu karşılaştır
 */
function verifyBleTokens(sessionId, bleTokens) {
    const db = loadDB();

    // Bu oturumdaki tüm katılımları al
    const attendances = db.attendances.filter(a => a.sessionId === sessionId);

    const verified = [];
    const suspicious = []; // Aynı cihazdan birden fazla öğrenci

    // Device ID kontrolü
    const deviceMap = {};
    attendances.forEach(a => {
        if (a.deviceId) {
            if (!deviceMap[a.deviceId]) deviceMap[a.deviceId] = [];
            deviceMap[a.deviceId].push(a.studentName);
        }
    });

    // BLE token eşleştir
    bleTokens.forEach(token => {
        const match = attendances.find(a => a.bleToken === token);
        if (match) {
            match.bleVerified = true;
            match.bleVerifiedAt = new Date().toISOString();

            // Aynı cihazdan başka öğrenci var mı?
            const sameDevice = deviceMap[match.deviceId];
            const isSuspicious = sameDevice && sameDevice.length > 1;

            verified.push({
                studentName: match.studentName,
                studentId: match.studentId,
                bleToken: token,
                deviceId: match.deviceId,
                suspicious: isSuspicious,
                sameDeviceStudents: isSuspicious ? sameDevice : null
            });
        }
    });

    saveDB(db);
    return verified;
}

/**
 * Oturumdaki yoklama listesini getir
 */
function getSessionRoster(sessionId) {
    const db = loadDB();
    return db.attendances.filter(a => a.sessionId === sessionId);
}

/**
 * Sui hash'lerini kaydet (final onay)
 */
function saveSuiHashes(sessionId, suiHashes) {
    const db = loadDB();
    suiHashes.forEach(({ studentId, suiHash }) => {
        const att = db.attendances.find(
            a => a.sessionId === sessionId && a.studentId === studentId
        );
        if (att) att.suiHash = suiHash;
    });
    saveDB(db);
}

module.exports = {
    findUserByUsername,
    getCoursesByLecturer,
    getCourseById,
    getStudentsByCourse,
    getStudentByTcNo,
    createSession,
    getSessionById,
    finalizeSession,
    getActiveSessionsByCourse,
    studentJoinSession,
    verifyBleTokens,
    getSessionRoster,
    saveSuiHashes,
    loadDB
};
