const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");

const app = express();
const db = new Database("data.sqlite");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  food_count INTEGER NOT NULL DEFAULT 0,
  welfare_count INTEGER NOT NULL DEFAULT 0,
  flour_count INTEGER NOT NULL DEFAULT 0,
  list_date TEXT NOT NULL,
  card_number TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error("Set ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET before starting.");
  process.exit(1);
}
const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(process.env.ADMIN_USERNAME);
if (!existing) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
  db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run(process.env.ADMIN_USERNAME, hash);
}

app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "site_session",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 2 * 60 * 60 * 1000 }
}));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));
app.use(express.static(path.join(__dirname, "public")));

function adminOnly(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: "يلزم تسجيل الدخول" });
  next();
}
function cleanText(v) { return String(v ?? "").trim(); }
function validateRecord(r) {
  const full_name = cleanText(r.full_name);
  const list_date = cleanText(r.list_date);
  const card_number = cleanText(r.card_number);
  const food_count = Number(r.food_count ?? 0);
  const welfare_count = Number(r.welfare_count ?? 0);
  const flour_count = Number(r.flour_count ?? 0);
  if (!full_name || !list_date || !card_number) throw new Error("الاسم والتاريخ ورقم البطاقة مطلوبة");
  for (const n of [food_count, welfare_count, flour_count]) {
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw new Error("الأعداد يجب أن تكون أرقاماً صحيحة غير سالبة");
  }
  return { full_name, list_date, card_number, food_count, welfare_count, flour_count };
}
const insertRecord = db.prepare(`INSERT INTO records
(full_name, food_count, welfare_count, flour_count, list_date, card_number)
VALUES (@full_name, @food_count, @welfare_count, @flour_count, @list_date, @card_number)`);
const updateRecord = db.prepare(`UPDATE records SET full_name=@full_name, food_count=@food_count,
welfare_count=@welfare_count, flour_count=@flour_count, list_date=@list_date,
card_number=@card_number WHERE id=@id`);

app.get("/api/search", rateLimit({ windowMs: 60 * 1000, limit: 30 }), (req, res) => {
  const q = cleanText(req.query.name);
  if (q.length < 2) return res.json([]);
  // Public response deliberately excludes card_number and internal IDs.
  const rows = db.prepare(`SELECT full_name, food_count, welfare_count, flour_count, list_date
    FROM records WHERE full_name LIKE ? COLLATE NOCASE ORDER BY full_name LIMIT 30`).all(`%${q}%`);
  res.json(rows);
});

app.post("/api/login", async (req, res) => {
  const username = cleanText(req.body.username);
  const password = String(req.body.password ?? "");
  const admin = db.prepare("SELECT * FROM admins WHERE username=?").get(username);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  }
  req.session.adminId = admin.id;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/admin/me", adminOnly, (req, res) => res.json({ ok: true }));
app.get("/api/admin/records", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM records ORDER BY id DESC LIMIT 1000").all());
});
app.post("/api/admin/records", adminOnly, (req, res) => {
  try { insertRecord.run(validateRecord(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/admin/records/:id", adminOnly, (req, res) => {
  try {
    const record = validateRecord(req.body);
    updateRecord.run({ ...record, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/admin/records/:id", adminOnly, (req, res) => {
  db.prepare("DELETE FROM records WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});
app.post("/api/admin/import", adminOnly, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "اختر ملف Excel أولاً" });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const aliases = {
      full_name: ["الاسم الثلاثي", "الاسم", "full_name"],
      food_count: ["العدد في الحصة الغذائية", "الحصة الغذائية", "food_count"],
      welfare_count: ["العدد في الرعاية الاجتماعية", "الرعاية الاجتماعية", "welfare_count"],
      flour_count: ["العدد في حصة الطحين", "حصة الطحين", "flour_count"],
      list_date: ["تاريخ القائمة", "list_date"],
      card_number: ["رقم البطاقة", "card_number"]
    };
    const pick = (row, key) => {
      const found = aliases[key].find(k => Object.prototype.hasOwnProperty.call(row, k));
      return found ? row[found] : "";
    };
    const tx = db.transaction((items) => {
      for (const row of items) {
        const dateValue = pick(row, "list_date");
        const date = dateValue instanceof Date ? dateValue.toISOString().slice(0,10) : String(dateValue).trim();
        const data = validateRecord({
          full_name: pick(row, "full_name"), food_count: pick(row, "food_count") || 0,
          welfare_count: pick(row, "welfare_count") || 0, flour_count: pick(row, "flour_count") || 0,
          list_date: date, card_number: pick(row, "card_number")
        });
        insertRecord.run(data);
      }
    });
    tx(rows);
    res.json({ ok: true, imported: rows.length });
  } catch (e) { res.status(400).json({ error: "تعذر الاستيراد: " + e.message }); }
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Site running on port ${port}`));
