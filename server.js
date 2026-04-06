const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('node:path');

const app  = express();
const PORT = 3000;

// ─── Your MySQL credentials 
const DB_CONFIG = {
  host:     'localhost',
  user:     'root',
  password: 'Dadzadee@06',
};

const DB_NAME = 'Faculty_Management_System';

let db;

// ─── Database Initialisation
async function initDB() {
  console.log('🔄 Connecting to MySQL...');
  const bootstrap = await mysql.createConnection(DB_CONFIG);
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await bootstrap.end();
  console.log(`✅ Database "${DB_NAME}" ready.`);

  db = mysql.createPool({
    ...DB_CONFIG,
    database:           DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
  });

  // employees table — includes role column
  await db.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      employee_id VARCHAR(20)  UNIQUE NOT NULL,
      password    VARCHAR(255) NOT NULL,
      name        VARCHAR(100) NOT NULL,
      department  VARCHAR(100) NOT NULL,
      role        VARCHAR(10)  NOT NULL DEFAULT 'faculty'
    )
  `);

  // Add role column if upgrading from old schema (silently skip if exists)
  await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS role VARCHAR(10) NOT NULL DEFAULT 'faculty'`).catch(() => {});

  // leave_requests table — includes admin review columns
  await db.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      employee_id    VARCHAR(20)  NOT NULL,
      faculty_name   VARCHAR(100) NOT NULL,
      department     VARCHAR(100) NOT NULL,
      leave_type     VARCHAR(100) NOT NULL,
      start_date     DATE         NOT NULL,
      end_date       DATE         NOT NULL,
      reason         TEXT         NOT NULL,
      coverage_plan  TEXT,
      status         VARCHAR(20)  NOT NULL DEFAULT 'Pending',
      admin_comment  TEXT,
      reviewed_by    VARCHAR(100),
      reviewed_at    DATETIME,
      submitted_at   DATETIME     DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Safely add missing columns — compatible with MySQL 5.7 and 8.0
  const colsToAdd = [
    { table: 'leave_requests', col: 'admin_comment', def: 'TEXT' },
    { table: 'leave_requests', col: 'reviewed_by',   def: 'VARCHAR(100)' },
    { table: 'leave_requests', col: 'reviewed_at',   def: 'DATETIME' },
    { table: 'employees',      col: 'role',           def: "VARCHAR(10) NOT NULL DEFAULT 'faculty'" },
  ];
  for (const { table, col, def } of colsToAdd) {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_NAME, table, col]
    );
    if (row.cnt === 0) {
      await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
      console.log(`  + Added column ${table}.${col}`);
    }
  }

  // Seed demo admin + faculty
  const seeds = [
    ['ADMIN001', 'admin123',    'Admin User',        'Administration',        'admin'],
    ['EMP001',   'password123', 'Dr. Alice Johnson', 'Computer Science',      'faculty'],
    ['EMP002',   'password123', 'Prof. Bob Smith',   'Mathematics',           'faculty'],
    ['EMP003',   'password123', 'Dr. Carol White',   'Mechanical Engineering','faculty'],
    ['EMP004',   'password123', 'Prof. David Brown', 'Humanities',            'faculty'],
  ];
  for (const s of seeds) {
    await db.query(
      `INSERT IGNORE INTO employees (employee_id, password, name, department, role) VALUES (?, ?, ?, ?, ?)`, s
    );
  }

  console.log('✅ Tables ready & seed data loaded.');
  console.log('   Demo Admin   → ID: ADMIN001  Password: admin123');
  console.log('   Demo Faculty → ID: EMP001    Password: password123');
}

// ─── Middleware 
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use((req, res, next) => { console.log(`📨 ${req.method} ${req.url}`); next(); });

// ─── Page Routes 
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, '../frontend/login.html')));
app.get('/register',  (req, res) => res.sendFile(path.join(__dirname, '../frontend/register.html')));
app.get('/form',      (req, res) => res.sendFile(path.join(__dirname, '../frontend/form.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/dashboard.html')));

// ─── API: Health 
app.get('/api/health', (req, res) => res.json({ success: true, message: 'Server is running.' }));

// ─── API: Register 
app.post('/api/register', async (req, res) => {
  const { employeeId, password, name, department, role } = req.body;

  if (!employeeId || !password || !name || !department || !role)
    return res.status(400).json({ success: false, message: 'All fields are required.' });

  if (!['admin', 'faculty'].includes(role))
    return res.status(400).json({ success: false, message: 'Role must be admin or faculty.' });

  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

  try {
    await db.query(
      `INSERT INTO employees (employee_id, password, name, department, role) VALUES (?, ?, ?, ?, ?)`,
      [employeeId, password, name, department, role]
    );
    console.log(`✅ Registered: ${name} (${role})`);
    return res.json({ success: true, message: 'Registration successful! You can now log in.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Employee ID already exists.' });
    console.error('❌ Register error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── API: Login ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { employeeId, password } = req.body;
  if (!employeeId || !password)
    return res.status(400).json({ success: false, message: 'Employee ID and password are required.' });

  try {
    const [rows] = await db.query(
      `SELECT * FROM employees WHERE employee_id = ? AND password = ?`,
      [employeeId, password]
    );
    if (rows.length === 0)
      return res.status(401).json({ success: false, message: 'Invalid Employee ID or password.' });

    const emp = rows[0];
    console.log(`✅ Login OK: ${emp.name} (${emp.role})`);
    return res.json({
      success:  true,
      message:  'Login successful.',
      employee: { employeeId: emp.employee_id, name: emp.name, department: emp.department, role: emp.role },
    });
  } catch (err) {
    console.error('❌ Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── API: Submit Leave ────────────────────────────────────────────────────────
app.post('/api/leave', async (req, res) => {
  const { employeeId, facultyName, department, leaveType, startDate, endDate, reason, coveragePlan } = req.body;

  if (!employeeId || !facultyName || !department || !leaveType || !startDate || !endDate || !reason)
    return res.status(400).json({ success: false, message: 'All required fields must be filled.' });

  if (new Date(endDate) < new Date(startDate))
    return res.status(400).json({ success: false, message: 'End date cannot be before start date.' });

  try {
    const [result] = await db.query(
      `INSERT INTO leave_requests (employee_id, faculty_name, department, leave_type, start_date, end_date, reason, coverage_plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, facultyName, department, leaveType, startDate, endDate, reason, coveragePlan || '']
    );
    return res.json({ success: true, message: 'Leave request submitted!', requestId: result.insertId });
  } catch (err) {
    console.error('❌ Leave error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to submit.' });
  }
});

// ─── API: Faculty leave history ───────────────────────────────────────────────
app.get('/api/leave/:employeeId', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY submitted_at DESC`,
      [req.params.employeeId]
    );
    return res.json({ success: true, requests: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── API: Admin — all leaves (filterable) ─────────────────────────────────────
app.get('/api/admin/leaves', async (req, res) => {
  const { department, status } = req.query;
  let sql = `SELECT * FROM leave_requests WHERE 1=1`;
  const params = [];
  if (department && department !== 'all') { sql += ` AND department = ?`; params.push(department); }
  if (status     && status     !== 'all') { sql += ` AND status = ?`;     params.push(status); }
  sql += ` ORDER BY submitted_at DESC`;

  try {
    const [rows] = await db.query(sql, params);
    return res.json({ success: true, requests: rows });
  } catch (err) {
    console.error('❌ Admin fetch error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── API: Admin — approve / reject ───────────────────────────────────────────
app.patch('/api/admin/leaves/:id', async (req, res) => {
  const { id } = req.params;
  const { status, adminComment, reviewedBy } = req.body;

  if (!['Approved', 'Rejected'].includes(status))
    return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected.' });

  try {
    const [result] = await db.query(
      `UPDATE leave_requests SET status = ?, admin_comment = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [status, adminComment || '', reviewedBy || 'Admin', id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Leave request not found.' });

    console.log(`✅ Leave #${id} → ${status}`);
    return res.json({ success: true, message: `Leave request ${status}.` });
  } catch (err) {
    console.error('❌ Review error — full details:', err);
    return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
});

//  API: Admin — stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [[{ total }]]    = await db.query(`SELECT COUNT(*) AS total    FROM leave_requests`);
    const [[{ pending }]]  = await db.query(`SELECT COUNT(*) AS pending  FROM leave_requests WHERE status='Pending'`);
    const [[{ approved }]] = await db.query(`SELECT COUNT(*) AS approved FROM leave_requests WHERE status='Approved'`);
    const [[{ rejected }]] = await db.query(`SELECT COUNT(*) AS rejected FROM leave_requests WHERE status='Rejected'`);
    return res.json({ success: true, stats: { total, pending, approved, rejected } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 FLMS running at http://localhost:${PORT}`);
      console.log(`   Login     : http://localhost:${PORT}/`);
      console.log(`   Register  : http://localhost:${PORT}/register`);
      console.log(`   Leave Form: http://localhost:${PORT}/form`);
      console.log(`   Dashboard : http://localhost:${PORT}/dashboard\n`);
    });
  })
  .catch((err) => { console.error('❌ Failed to start:', err.message); process.exit(1); });