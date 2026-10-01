const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;
const memoryOrders = [];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const STATUSES = ["new","review","approved","designing","preview","done"];
function admin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  const received = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !received || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return res.status(401).json({ error: "Unauthorized" });
  next();
}
async function ensureDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, business TEXT NOT NULL,
    video_type TEXT NOT NULL, platform TEXT NOT NULL, duration TEXT, details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
function normalize(body) {
  const fields=["name","phone","business","videoType","platform","details"];
  for (const f of fields) if (!String(body[f]||"").trim()) throw new Error("Missing required field");
  return {name:String(body.name).trim(),phone:String(body.phone).trim(),business:String(body.business).trim(),videoType:String(body.videoType).trim(),platform:String(body.platform).trim(),duration:String(body.duration||"").trim(),details:String(body.details).trim()};
}
app.get("/health", async (_req,res)=>{res.json({ok:true,service:"alivizo",database:Boolean(pool),time:new Date().toISOString()})});
app.post("/api/orders", async (req,res)=>{
  try {
    const o=normalize(req.body), id="ALV-"+Date.now().toString().slice(-6);
    if (pool) await pool.query("INSERT INTO orders (id,name,phone,business,video_type,platform,duration,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[id,o.name,o.phone,o.business,o.videoType,o.platform,o.duration,o.details]);
    else memoryOrders.unshift({id,...o,status:"new",created_at:new Date().toISOString()});
    res.status(201).json({ok:true,orderId:id});
  } catch(e) { res.status(400).json({ok:false,error:"تعذر تسجيل الطلب"}); }
});
app.get("/api/admin/orders",admin,async (_req,res)=>{
  try {
    const orders=pool ? (await pool.query("SELECT id,name,phone,business,video_type,platform,duration,details,status,created_at FROM orders ORDER BY created_at DESC")).rows : memoryOrders;
    res.json({orders});
  } catch(e){res.status(500).json({error:"Database error"});}
});
app.patch("/api/admin/orders/:id",admin,async (req,res)=>{
  const status=String(req.body.status||"");
  if(!STATUSES.includes(status)) return res.status(400).json({error:"Invalid status"});
  try {
    if(pool){const r=await pool.query("UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id",[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Not found"});}
    else {const o=memoryOrders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:"Not found"});o.status=status;}
    res.json({ok:true});
  } catch(e){res.status(500).json({error:"Database error"});}
});
app.get("/admin",(_req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*splat",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
ensureDb().catch(e=>console.error("DB init failed:",e.message));
app.listen(PORT,"0.0.0.0",()=>console.log(`Alivizo running on port ${PORT}`));