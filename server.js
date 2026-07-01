// server.js — Dijital Tanık Portal API
const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path       = require('path');
const crypto     = require('crypto');
const db         = require('./db');

const app    = express();
const PORT   = 3000;
const SECRET = 'dijital-tanik-secret-2026'; // Gerçek üretimde env variable

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────

function requireAuth(req, res, next) {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Giriş yapılmamış' });
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Oturum süresi doldu' });
    }
}

// ── Auth API ─────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Şifre hatalı' });

    const token = jwt.sign(
        { id: user.id, username: user.username, fullName: user.fullName, role: user.role },
        SECRET,
        { expiresIn: '8h' }
    );

    res.cookie('token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, fullName: user.fullName, role: user.role } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ ok: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// ── Ders API ─────────────────────────────────────────────

// GET /api/courses
app.get('/api/courses', requireAuth, (req, res) => {
    const courses = db.getCoursesByLecturer(req.user.id);
    res.json({ courses });
});

// GET /api/courses/:courseId/students
app.get('/api/courses/:courseId/students', requireAuth, (req, res) => {
    const students = db.getStudentsByCourse(req.params.courseId);
    // TC no'yu gizle (sadece isim ve öğrenci no döner)
    const safe = students.map(({ id, studentNo, fullName }) => ({ id, studentNo, fullName }));
    res.json({ students: safe });
});

// ── Oturum API ───────────────────────────────────────────

// POST /api/sessions/start — Akademisyen yoklama başlatır
app.post('/api/sessions/start', requireAuth, (req, res) => {
    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ error: 'courseId gerekli' });

    const course = db.getCourseById(courseId);
    if (!course) return res.status(404).json({ error: 'Ders bulunamadı' });
    if (course.lecturerId !== req.user.id)
        return res.status(403).json({ error: 'Bu ders size ait değil' });

    const session = db.createSession(courseId, req.user.id);

    // yoklama_kodu akademisyene döner (APK'ya BLE/QR ile aktarılacak)
    // Bir kez gösterilir, sonra portal bunu göstermez
    res.json({
        ok: true,
        sessionId: session.id,
        yoklamaKodu: session.yoklamaKodu,  // ← Sadece bu anda görünür!
        course: { code: course.code, name: course.name },
        createdAt: session.createdAt
    });
});

// GET /api/sessions/active — Öğrenci APK'sı aktif oturumları çeker
app.get('/api/sessions/active', (req, res) => {
    const data = db.loadDB();
    const active = data.sessions.filter(s => s.status === 'active').map(s => {
        const course   = db.getCourseById(s.courseId);
        const lecturer = data.users.find(u => u.id === s.lecturerId);
        return {
            id:         s.id,
            courseCode: course?.code || '',
            courseName: course?.name || '',
            lecturer:   lecturer?.fullName || '',
            createdAt:  s.createdAt
        };
    });
    res.json({ sessions: active });
});

// GET /api/sessions/:sessionId — Oturum bilgisi
app.get('/api/sessions/:sessionId', requireAuth, (req, res) => {
    const session = db.getSessionById(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });

    const course = db.getCourseById(session.courseId);
    const roster = db.getSessionRoster(session.id);

    res.json({
        session: {
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
            finalizedAt: session.finalizedAt,
            suiTxHash: session.suiTxHash
        },
        course,
        roster: roster.map(a => ({
            studentName: a.studentName,
            bleVerified: a.bleVerified,
            bleVerifiedAt: a.bleVerifiedAt,
            deviceId: a.deviceId,
            portalJoinedAt: a.portalJoinedAt
        })),
        totalJoined: roster.length,
        totalVerified: roster.filter(a => a.bleVerified).length
    });
});

// POST /api/sessions/:sessionId/finalize — Yoklamayı Sui'ye gönder
app.post('/api/sessions/:sessionId/finalize', requireAuth, (req, res) => {
    const session = db.getSessionById(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
    if (session.lecturerId !== req.user.id)
        return res.status(403).json({ error: 'Yetkisiz işlem' });
    if (session.status === 'finalized')
        return res.status(400).json({ error: 'Oturum zaten sonlandırıldı' });

    const { suiTxHash } = req.body;
    const updated = db.finalizeSession(session.id, suiTxHash || 'PENDING');

    res.json({ ok: true, session: updated });
});

// ── Öğrenci Yoklama API ──────────────────────────────────

// POST /api/attendance/join — Öğrenci "Yoklamaya Katıl" basar
// NOT: Gerçekte öğrenci kendi hesabıyla giriş yapar.
// Test için courseId + studentId gönderiyoruz.
app.post('/api/attendance/join', (req, res) => {
    const { sessionId, studentId, deviceId } = req.body;

    if (!sessionId || !studentId)
        return res.status(400).json({ error: 'sessionId ve studentId gerekli' });

    const session = db.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
    if (session.status !== 'active')
        return res.status(400).json({ error: 'Oturum aktif değil' });

    const result = db.studentJoinSession(sessionId, studentId, deviceId || 'unknown');
    if (!result) return res.status(404).json({ error: 'Öğrenci bulunamadı' });

    // yoklama_kodu öğrenciye döner — APK bunu NFC hash'i için kullanacak
    res.json({
        ok: true,
        yoklamaKodu: result.yoklamaKodu,
        message: 'Yoklamaya katıldınız. TC kimliğinizi okutun.'
    });
});

// POST /api/attendance/verify-ble — Akademisyen BLE token listesi gönderir
app.post('/api/attendance/verify-ble', requireAuth, (req, res) => {
    const { sessionId, bleTokens } = req.body;

    if (!sessionId || !Array.isArray(bleTokens))
        return res.status(400).json({ error: 'sessionId ve bleTokens[] gerekli' });

    const session = db.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: 'Oturum bulunamadı' });
    if (session.lecturerId !== req.user.id)
        return res.status(403).json({ error: 'Yetkisiz işlem' });

    const verified = db.verifyBleTokens(sessionId, bleTokens);

    // Şüpheli cihaz kontrolü
    const suspicious = verified.filter(v => v.suspicious);

    res.json({
        ok: true,
        verified,
        totalVerified: verified.length,
        suspicious: suspicious.length > 0 ? suspicious : null
    });
});

// ── Test: şifre hash üret ────────────────────────────────
app.get('/api/dev/hash/:password', async (req, res) => {
    const hash = await bcrypt.hash(req.params.password, 10);
    res.json({ hash });
});

// GET /api/dev/roster-tokens/:sessionId — Test simülatörü için BLE token listesi
// (Gerçekte bu bilgi APK'dan BLE advertisement ile gelir, portal görmez)
app.get('/api/dev/roster-tokens/:sessionId', requireAuth, (req, res) => {
    const roster = db.getSessionRoster(req.params.sessionId);
    const tokens = roster.map(a => a.bleToken).filter(Boolean);
    res.json({ tokens });
});

// ── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎓 Dijital Tanık Portal`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`\nTest hesabı:`);
    console.log(`  Kullanıcı adı: zafer.bozyer`);
    console.log(`  Şifre: akademisyen123\n`);
});
