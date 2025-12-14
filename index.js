// ----------------------------------------------------------
// KARNI FASHIONS BACKEND — PostgreSQL (Supabase)
// ----------------------------------------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { pool } = require("./db");

const app = express();

// ----------------------------------------------------------
// FIREBASE
// ----------------------------------------------------------
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// ----------------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------------
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

// ----------------------------------------------------------
// ROOT
// ----------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Karni Fashions API (PostgreSQL) is live");
});

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    const q = `
      SELECT userid, username, fullname, role, customertype,
             businessname, address, mobile
      FROM tblusers
      WHERE username = $1 AND passwordhash = $2
    `;

    const r = await pool.query(q, [username, password]);

    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");

    res.json({
      success: true,
      token,
      user: r.rows[0]
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed", detail: err.message });
  }
});


// ----------------------------------------------------------
// SIGNUP
// ----------------------------------------------------------
app.post("/signup", async (req, res) => {
  try {
    const { username, password, fullName, businessName, address, mobile } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });

    await pool.query(
      `INSERT INTO tblUsers
       (Username, PasswordHash, FullName, Role, CustomerType, BusinessName, Address, Mobile)
       VALUES ($1,$2,$3,'Customer',1,$4,$5,$6)`,
      [username, password, fullName, businessName, address, mobile]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Signup failed" });
  }
});
// ----------------------------------------------------------
// FCM TOKEN SAVE
// ----------------------------------------------------------
app.post("/fcm/save", async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ error: "userId and token required" });
    }

    await pool.query(
      `
      INSERT INTO tblfcm_tokens (user_id, token)
      VALUES ($1, $2)
      ON CONFLICT (token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        last_seen = now();
      `,
      [userId, token]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("FCM SAVE ERROR:", e);
    res.status(500).json({ error: "Failed to save FCM token" });
  }
});

// ----------------------------------------------------------
// PRODUCTS
// ----------------------------------------------------------
app.get("/products", async (_, res) => {
  const r = await pool.query(`
    SELECT ProductID, Item, SeriesName, CategoryName
    FROM tblProduct
    ORDER BY Item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// SERIES & CATEGORIES
// ----------------------------------------------------------
app.get("/series", async (_, res) => {
  const r = await pool.query(
    `SELECT SeriesName FROM tblSeries WHERE IsActive = true ORDER BY SeriesName`
  );
  res.json(r.rows);
});

app.get("/categories", async (_, res) => {
  const r = await pool.query(
    `SELECT CategoryName FROM tblCategory WHERE IsActive = true ORDER BY CategoryName`
  );
  res.json(r.rows);
});

// ----------------------------------------------------------
// IMAGES
// ----------------------------------------------------------
app.get("/image/:productId", async (req, res) => {
  const r = await pool.query(
    `SELECT ProductID, ImageURL FROM tblItemImages WHERE ProductID = $1`,
    [req.params.productId]
  );
  res.json(r.rows[0] || {});
});

app.get("/images/list", async (_, res) => {
  const r = await pool.query(`
    SELECT P.ProductID, P.Item, COALESCE(I.ImageURL,'') AS ImageURL
    FROM tblProduct P
    LEFT JOIN tblItemImages I ON I.ProductID = P.ProductID
    ORDER BY P.Item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// STOCK
// ----------------------------------------------------------
app.post("/stock", async (req, res) => {
  const { role, customerType } = req.body;
  const r = await pool.query(`SELECT * FROM vwStockSummary`);
  let stock = r.rows;

  if (role === "Customer" && customerType == 1) return res.json([]);

  if (role === "Customer" && customerType == 2) {
    stock = stock.map(s => ({
      ProductID: s.productid,
      Item: s.item,
      SeriesName: s.seriesname,
      CategoryName: s.categoryname,
      Availability: s.totalqty > 5 ? "Available" : ""
    }));
  }
  res.json(stock);
});

// ----------------------------------------------------------
// INCOMING (MULTI ROW, TRANSACTIONAL)
// ----------------------------------------------------------
app.post("/incoming", async (req, res) => {
  const client = await pool.connect();
  try {
    const { UserName, Location, Rows } = req.body;
    await client.query("BEGIN");

    const h = await client.query(
      `INSERT INTO tblIncomingHeader (UserName, Location)
       VALUES ($1,$2) RETURNING IncomingHeaderID`,
      [UserName, Location]
    );
    const headerId = h.rows[0].incomingheaderid;

    for (const r of Rows) {
      const p = await client.query(
        `SELECT ProductID FROM tblProduct
         WHERE Item=$1 AND SeriesName=$2 AND CategoryName=$3`,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      let productId;
      if (p.rows.length) productId = p.rows[0].productid;
      else {
        const np = await client.query(
          `INSERT INTO tblProduct (Item, SeriesName, CategoryName)
           VALUES ($1,$2,$3) RETURNING ProductID`,
          [r.Item, r.SeriesName, r.CategoryName]
        );
        productId = np.rows[0].productid;
      }

      await client.query(
        `INSERT INTO tblIncomingDetails
         (IncomingHeaderID, ProductID, Item, SeriesName, CategoryName, Quantity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [headerId, productId, r.Item, r.SeriesName, r.CategoryName, r.Quantity]
      );

      await client.query(
        `INSERT INTO tblStock (ProductID, Item, SeriesName, CategoryName, TotalQuantity)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (ProductID)
         DO UPDATE SET TotalQuantity = tblStock.TotalQuantity + EXCLUDED.TotalQuantity`,
        [productId, r.Item, r.SeriesName, r.CategoryName, r.Quantity]
      );

      await client.query(
        `INSERT INTO tblStockByLocation
         (ProductID, Item, SeriesName, CategoryName, LocationName, Quantity)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (Item,SeriesName,CategoryName,LocationName)
         DO UPDATE SET Quantity = tblStockByLocation.Quantity + EXCLUDED.Quantity`,
        [productId, r.Item, r.SeriesName, r.CategoryName, Location, r.Quantity]
      );

      await client.query(
        `INSERT INTO tblStockLedger
         (MovementType, ReferenceID, Item, SeriesName, CategoryName, Quantity, LocationName, UserName)
         VALUES ('Incoming',$1,$2,$3,$4,$5,$6,$7)`,
        [headerId, r.Item, r.SeriesName, r.CategoryName, r.Quantity, Location, UserName]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, headerID: headerId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// SALES (MULTI ROW, TRANSACTIONAL)
// ----------------------------------------------------------
app.post("/sales", async (req, res) => {
  const client = await pool.connect();
  try {
    const { UserName, Location, Customer, VoucherNo, Rows } = req.body;
    await client.query("BEGIN");

    const h = await client.query(
      `INSERT INTO tblSalesHeader
       (UserName, LocationName, Customer, VoucherNo)
       VALUES ($1,$2,$3,$4) RETURNING SalesID`,
      [UserName, Location, Customer, VoucherNo]
    );
    const salesId = h.rows[0].salesid;

    for (const r of Rows) {
      const p = await client.query(
        `SELECT ProductID FROM tblProduct WHERE Item=$1 AND SeriesName=$2`,
        [r.Item, r.SeriesName]
      );
      const productId = p.rows[0].productid;

      await client.query(
        `INSERT INTO tblSalesDetails
         (SalesID, Item, Quantity, Series, Category, ProductID)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [salesId, r.Item, r.Quantity, r.SeriesName, r.CategoryName, productId]
      );

      await client.query(
        `UPDATE tblStockByLocation
         SET Quantity = Quantity - $1
         WHERE ProductID=$2 AND LocationName=$3`,
        [r.Quantity, productId, Location]
      );

      await client.query(
        `UPDATE tblStock SET TotalQuantity = TotalQuantity - $1
         WHERE ProductID=$2`,
        [r.Quantity, productId]
      );

      await client.query(
        `INSERT INTO tblStockLedger
         (MovementType, ReferenceID, Item, SeriesName, CategoryName, Quantity, LocationName, UserName)
         VALUES ('OUT',$1,$2,$3,$4,$5,$6,$7)`,
        [salesId, r.Item, r.SeriesName, r.CategoryName, r.Quantity, Location, UserName]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, salesID: salesId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// FIREBASE NOTIFICATION
// ----------------------------------------------------------
app.post("/send-notification", async (req, res) => {
  try {
    const { token, title, body } = req.body;
    const r = await admin.messaging().send({
      token,
      notification: { title, body }
    });
    res.json({ success: true, r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// START
// ----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Karni API running on port ${PORT}`)
);
