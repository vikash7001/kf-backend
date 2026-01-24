const { logActivity } = require('./activityLogger');
require("./firebase");
const {
  notifyAdminLogin,
  notifyAdminSale,
  notifyIncoming,
  notifyAppUpdate,
  notifyNewImage
} = require("./notificationService");

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
// MIDDLEWARE
// ----------------------------------------------------------
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.options("*", cors());
app.use(express.json());
// ----------------------------------------------------------
// DISABLE CACHE FOR API RESPONSES (Cloudflare-safe)
// ----------------------------------------------------------
app.use((req, res, next) => {
  // Disable caching for all API responses
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  next();
});
function buildStockCondition(mode, role) {
  // Customers are always forced to "either"
  if (role === "customer") {
    return `(s.jaipurqty > 5 OR s.kolkataqty > 5)`;
  }

  switch (mode) {
    case "all":
      return null; // IMPORTANT: means "do not use stock at all"
    case "jaipur":
      return `s.jaipurqty > 5`;
    case "kolkata":
      return `s.kolkataqty > 5`;
    case "either":
    default:
      return `(s.jaipurqty > 5 OR s.kolkataqty > 5)`;
  }
}

// ----------------------------------------------------------
// ROOT
// ----------------------------------------------------------
app.get("/", (_, res) => {
  res.send("Karni Fashions API (PostgreSQL) is live");
});
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// ----------------------------------------------------------
// LOGIN
// ----------------------------------------------------------
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

const r = await pool.query(
  `
  SELECT userid, username, fullname, role
  FROM tblusers
  WHERE LOWER(username) = LOWER($1)
    AND passwordhash = $2
  `,
  [username, password]
);


    if (r.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = r.rows[0];

    await logActivity({
      userId: user.userid,
      username: user.username,
      actionType: "LOGIN",
      description: `User ${user.username} logged in`
    });

    // 🔔 LOGIN NOTIFICATION (ADMIN ONLY)
    try {
      await notifyAdminLogin(user.fullname);
    } catch (err) {
      console.error("Login notification failed:", err);
      // DO NOT block login
    }

    const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");

    return res.json({
      success: true,
      token,
      user
    });

  } catch (e) {
    console.error("LOGIN ERROR:", e);
    return res.status(500).json({
      error: e?.message || "Unknown server error"
    });
  }
});


app.post("/signup", async (req, res) => {
  try {
    const {
      username,
      password,
      fullName,
      businessName,
      address,
      mobile
    } = req.body;

    // Basic validation
    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required"
      });
    }

    // Check if username already exists
    const exists = await pool.query(
      "SELECT 1 FROM tblusers WHERE username = $1",
      [username]
    );

    if (exists.rows.length > 0) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    // Insert user (ONLY existing columns)
    const insert = await pool.query(
      `
      INSERT INTO tblusers
      (
        username,
        passwordhash,
        fullname,
        businessname,
        address,
        mobile
      )
      VALUES
        ($1,$2,$3,$4,$5,$6)
      RETURNING
        userid,
        username,
        fullname,
        role
      `,
      [
        username,
        password,          // later replace with bcrypt hash
        fullName || null,
        businessName || null,
        address || null,
        mobile || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Signup successful",
      user: insert.rows[0]
    });

  } catch (e) {
    console.error("SIGNUP ERROR:", e);
    return res.status(500).json({
      error: e.message
    });
  }
});

// ----------------------------------------------------------
// PRODUCTS
// ----------------------------------------------------------
app.get("/products", async (_, res) => {
  const r = await pool.query(`
    SELECT
      productid AS "ProductID",
      item AS "Item",
      seriesname AS "SeriesName",
      categoryname AS "CategoryName"
    FROM tblproduct
    ORDER BY item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// SERIES (RESTORED)
// ----------------------------------------------------------
app.get("/series", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        seriesname   AS "SeriesName",
        categoryname AS "CategoryName"
      FROM tblseries
      WHERE isactive = true
      ORDER BY seriesname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/customers", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT
        customerid   AS "CustomerID",
        customername AS "CustomerName"
      FROM tblcustomer
      ORDER BY customername
    `);

    res.json(r.rows);
  } catch (err) {
    console.error("CUSTOMERS API ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------
// CATEGORIES (RESTORED)
// ----------------------------------------------------------
app.get("/categories", async (_, res) => {
  try {
    const r = await pool.query(`
      SELECT categoryname AS "CategoryName"
      FROM tblcategory
      WHERE isactive = true
      ORDER BY categoryname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/categories", async (req, res) => {
  try {
    const { CategoryName } = req.body;
    if (!CategoryName) {
      return res.status(400).json({ error: "CategoryName required" });
    }

    await pool.query(
      `INSERT INTO tblcategory (categoryname, isactive)
       VALUES ($1, true)`,
      [CategoryName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("CATEGORY POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/series", async (req, res) => {
  try {
    const { SeriesName, CategoryName } = req.body;
    if (!SeriesName || !CategoryName) {
      return res.status(400).json({ error: "SeriesName & CategoryName required" });
    }

    await pool.query(
      `INSERT INTO tblseries (seriesname, categoryname, isactive)
       VALUES ($1, $2, true)`,
      [SeriesName.trim(), CategoryName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("SERIES POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/products", async (req, res) => {
  try {
    const { Item, SeriesName, CategoryName } = req.body;
    if (!Item || !SeriesName || !CategoryName) {
      return res.status(400).json({ error: "Item, SeriesName & CategoryName required" });
    }

    await pool.query(
      `INSERT INTO tblproduct (item, seriesname, categoryname)
       VALUES ($1, $2, $3)`,
      [Item.trim(), SeriesName.trim(), CategoryName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("PRODUCT POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/customers", async (req, res) => {
  try {
    const { CustomerName } = req.body;
    if (!CustomerName) {
      return res.status(400).json({ error: "CustomerName required" });
    }

    await pool.query(
      `INSERT INTO tblcustomer (customername)
       VALUES ($1)`,
      [CustomerName.trim()]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("CUSTOMER POST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// REGISTER / UPDATE FCM TOKEN
// ----------------------------------------------------------
app.post("/fcm/register", async (req, res) => {
  try {
    const { user_id, token, device } = req.body;

    if (!user_id || !token) {
      return res.status(400).json({ error: "user_id and token required" });
    }

    await pool.query(`
      INSERT INTO tblfcm_tokens (user_id, token, device, last_seen)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        device = EXCLUDED.device,
        last_seen = NOW()
    `, [user_id, token, device || 'android']);

    res.json({ success: true });
  } catch (e) {
    console.error("FCM REGISTER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// IMAGES (MANAGE IMAGE PAGE)
// ----------------------------------------------------------
app.get("/images/list", async (_, res) => {
  const r = await pool.query(`
    SELECT
      P.productid AS "ProductID",
      P.item AS "Item",
      COALESCE(I.imageurl,'n/a') AS "ImageURL"
    FROM tblproduct P
    LEFT JOIN tblitemimages I ON I.productid = P.productid
    ORDER BY P.item
  `);
  res.json(r.rows);
});

// ----------------------------------------------------------
// IMAGE SAVE (OLD – ITEM BASED)  ✅ RESTORED
// ----------------------------------------------------------
app.post("/image/save", async (req, res) => {
  try {
    const { Item, ImageURL } = req.body;

    if (!Item || !ImageURL) {
      return res.status(400).json({ error: "Item and ImageURL required" });
    }

    console.log("🔥 IMAGE/SAVE CALLED", { Item, ImageURL });

    // 1️⃣ Find product
    const p = await pool.query(
      `SELECT productid, seriesname FROM tblproduct WHERE item = $1`,
      [Item]
    );

    if (p.rows.length === 0) {
      console.warn("⚠️ PRODUCT NOT FOUND FOR IMAGE", Item);
      return res.status(404).json({ error: "Product not found" });
    }

    const productId = p.rows[0].productid;
    const seriesName = p.rows[0].seriesname;

    console.log("✅ PRODUCT FOUND", { productId, seriesName });

    // 2️⃣ Save / update image
    await pool.query(
      `
      INSERT INTO tblitemimages (productid, imageurl)
      VALUES ($1,$2)
      ON CONFLICT (productid)
      DO UPDATE SET imageurl = EXCLUDED.imageurl
      `,
      [productId, ImageURL]
    );

    console.log("✅ IMAGE SAVED", { productId });

    // 3️⃣ Send notification
    console.log("📣 SENDING NEW IMAGE NOTIFICATION");

    await notifyNewImage({
      imageUrl: ImageURL,
      seriesName: seriesName,
      itemName: Item
    });

    console.log("✅ notifyNewImage CALLED SUCCESSFULLY");

    res.json({ success: true });

  } catch (e) {
    console.error("❌ IMAGE/SAVE ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// IMAGE SAVE (NEW – PRODUCTID BASED, MANAGE IMAGES)
// ----------------------------------------------------------
app.post("/images/save", async (req, res) => {
  try {
    const { ProductID, ImageURL } = req.body;

    if (!ProductID || !ImageURL) {
      return res.status(400).json({ error: "ProductID and ImageURL required" });
    }

    console.log("🔥 IMAGE SAVE CALLED", { ProductID, ImageURL });

    // 1️⃣ Save / update image
    await pool.query(
      `
      INSERT INTO tblItemImages (ProductID, ImageURL)
      VALUES ($1,$2)
      ON CONFLICT (ProductID)
      DO UPDATE SET ImageURL = EXCLUDED.ImageURL
      `,
      [ProductID, ImageURL]
    );

    console.log("✅ IMAGE SAVED IN DB");

    // 2️⃣ Fetch item + series
    const info = await pool.query(
      `
      SELECT item, seriesname
      FROM tblproduct
      WHERE productid = $1
      `,
      [ProductID]
    );

    console.log("🔎 PRODUCT LOOKUP RESULT", info.rows);

    // 3️⃣ Send notification
    if (info.rows.length > 0) {
      console.log("📣 SENDING IMAGE NOTIFICATION");

      await notifyNewImage({
        imageUrl: ImageURL,
        seriesName: info.rows[0].seriesname,
        itemName: info.rows[0].item
      });

      console.log("✅ notifyNewImage CALLED");
    } else {
      console.warn("⚠️ NO PRODUCT FOUND FOR NOTIFICATION");
    }

    res.json({ success: true });

  } catch (err) {
    console.error("❌ IMAGE SAVE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/images/series/list-with-item", async (req, res) => {
  try {
    const seriesList = req.body;

    if (!Array.isArray(seriesList) || seriesList.length === 0) {
      return res.status(400).json({ error: "Series list required" });
    }

    const result = await pool.query(
      `
      SELECT
        p.productid AS "ProductID",
        p.item       AS "Item",
        i.imageurl   AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p
        ON p.productid = i.productid
      WHERE p.seriesname = ANY($1)
      `,
      [seriesList]
    );

    res.json(result.rows);

  } catch (e) {
    console.error("❌ images/series/list-with-item error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/images/series/:series", async (req, res) => {
  try {
    const { series } = req.params;
    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.seriesname = $1
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
    `, [series]);

    res.json(r.rows);
  } catch (e) {
    console.error("SERIES IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/images/category/:category", async (req, res) => {
  try {
    const { category } = req.params;
    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.categoryname = $1
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
    `, [category]);

    res.json(r.rows);
  } catch (e) {
    console.error("CATEGORY IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post("/images/series/list", async (req, res) => {
  try {
    const seriesList = req.body;
    if (!Array.isArray(seriesList) || seriesList.length === 0)
      return res.json([]);

    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.seriesname = ANY($1)
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
    `, [seriesList]);

    res.json(r.rows);
  } catch (e) {
    console.error("MULTI-SERIES IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post("/images/category/list", async (req, res) => {
  try {
    const categoryList = req.body;
    if (!Array.isArray(categoryList) || categoryList.length === 0)
      return res.json([]);

    const mode = req.query.mode || "either";
    const role = (req.user?.role || "customer").toLowerCase();

    const stockCondition = buildStockCondition(mode, role);
    const useStock = stockCondition !== null;

    const r = await pool.query(`
      SELECT
        i.productid AS "ProductID",
        COALESCE(i.imageurl,'n/a') AS "ImageURL"
      FROM tblitemimages i
      JOIN tblproduct p ON p.productid = i.productid
      ${useStock ? "JOIN vwstocksummary s ON s.productid = p.productid" : ""}
      WHERE p.categoryname = ANY($1)
      ${useStock ? `AND ${stockCondition}` : ""}
      ORDER BY p.item DESC
    `, [categoryList]);

    res.json(r.rows);
  } catch (e) {
    console.error("MULTI-CATEGORY IMAGE ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// STOCK  ❌ UNCHANGED
// ----------------------------------------------------------
// ----------------------------------------------------------
// STOCK  ✅ ROLE ONLY (FINAL)
// ----------------------------------------------------------


app.post("/stock", async (req, res) => {
  try {
    const { role } = req.body;
    const roleKey = (role || "CUSTOMER").toUpperCase();

    const r = await pool.query(`
      SELECT
        productid AS "ProductID",
        item AS "Item",
        seriesname AS "SeriesName",
        categoryname AS "CategoryName",
        jaipurqty AS "JaipurQty",
        kolkataqty AS "KolkataQty",
        totalqty AS "TotalQty"
      FROM vwstocksummary
      ORDER BY item
    `);

    // ❌ CUSTOMER → NO STOCK
    if (roleKey === "CUSTOMER") {
      return res.json([]);
    }

    // ✅ CUSTOMER_PREMIUM → AVAILABILITY ONLY
if (roleKey === "CUSTOMER_PREMIUM") {
console.log("STOCK RESPONSE SAMPLE:", r.rows[0]);
  return res.json(
    r.rows.map(s => ({
      ProductID: s.ProductID,
      Item: s.Item,
      SeriesName: s.SeriesName,
      CategoryName: s.CategoryName,
      JaipurQty: Number(s.JaipurQty),
      KolkataQty: Number(s.KolkataQty)
    }))
  );
}


    // ✅ ADMIN / USER → FULL STOCK
    return res.json(r.rows);

  } catch (e) {
    console.error("STOCK API ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// GET ledger by product
app.get("/stockledger/:itemCode", async (req, res) => {
  try {
    const { itemCode } = req.params;

    const r = await pool.query(`
      SELECT
        ledgerid,
        movementdate,
        movementtype,
        referenceid,
        quantity,
        locationname,
        username
      FROM tblstockledger
      WHERE item = $1
      ORDER BY movementdate
    `, [itemCode]);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// INCOMING (PURCHASE)  ❌ UNCHANGED
// ----------------------------------------------------------
app.post("/incoming", async (req, res) => {
  const client = await pool.connect();

  try {
    const { UserID, UserName, Location, Rows } = req.body;

    if (!UserID || !UserName || !Location || !Array.isArray(Rows)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Resolve fullname
    const u = await client.query(
      "SELECT fullname FROM tblusers WHERE userid = $1",
      [UserID]
    );

    if (u.rows.length === 0) {
      throw new Error("Invalid user");
    }

    const createdByName = u.rows[0].fullname;

    // 2️⃣ Insert Incoming Header
    const h = await client.query(
      `
      INSERT INTO tblincomingheader (username, location)
      VALUES ($1, $2)
      RETURNING incomingheaderid
      `,
      [UserName, Location]
    );

    const headerId = h.rows[0].incomingheaderid;

    // 3️⃣ Process Incoming Rows
    for (const r of Rows) {

      const p = await client.query(
        `
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
        `,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      const productId = p.rows.length
        ? p.rows[0].productid
        : (
            await client.query(
              `
              INSERT INTO tblproduct (item, seriesname, categoryname)
              VALUES ($1,$2,$3)
              RETURNING productid
              `,
              [r.Item, r.SeriesName, r.CategoryName]
            )
          ).rows[0].productid;

      await client.query(
        `
        INSERT INTO tblincomingdetails
        (incomingheaderid, productid, item, seriesname, categoryname, quantity)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [headerId, productId, r.Item, r.SeriesName, r.CategoryName, r.Quantity]
      );

      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname, quantity, locationname, username)
        VALUES ('Incoming', $1, $2, $3, $4, $5, $6, $7)
        `,
        [
          headerId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          Location,
          UserName
        ]
      );

      await client.query(
        `
        INSERT INTO tblstock
        (productid, item, seriesname, categoryname, totalquantity)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (productid)
        DO UPDATE SET totalquantity = tblstock.totalquantity + EXCLUDED.totalquantity
        `,
        [
          productId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity
        ]
      );
    }

    // 4️⃣ Commit
    await client.query("COMMIT");

    // 5️⃣ Activity log
    await logActivity({
      userId: UserID,
      username: UserName,
      actionType: "INCOMING",
      description: "Incoming entry created"
    });

    // 🔔 6️⃣ INCOMING NOTIFICATION (ADMIN + USER)
    try {
      await notifyIncoming({
        createdByName,
        location: Location,
        incomingHeaderId: headerId
      });
    } catch (err) {
      console.error("Incoming notification failed:", err);
    }

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Incoming error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// SALES  ❌ UNCHANGED
// ----------------------------------------------------------
app.post("/sales", async (req, res) => {
  const client = await pool.connect();

  try {
    const { UserName, Location, Customer, VoucherNo, Rows } = req.body;

    if (
      !UserName ||
      !Location ||
      !Customer ||
      !Array.isArray(Rows)
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // 1️⃣ Resolve userid + fullname from username
    const u = await client.query(
      `SELECT userid, fullname FROM tblusers WHERE username = $1`,
      [UserName]
    );

    if (u.rows.length === 0) {
      throw new Error("Invalid user");
    }

    const userId = u.rows[0].userid;
    const createdByName = u.rows[0].fullname;

    // 2️⃣ Insert Sales Header
    const h = await client.query(
      `
      INSERT INTO tblsalesheader
      (username, locationname, customer, voucherno)
      VALUES ($1,$2,$3,$4)
      RETURNING salesid
      `,
      [UserName, Location, Customer, VoucherNo]
    );

    const salesId = h.rows[0].salesid;

    // 3️⃣ Process Sales Rows
    for (const r of Rows) {

      const p = await client.query(
        `
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
        `,
        [r.Item, r.SeriesName, r.CategoryName]
      );

      if (p.rows.length === 0) {
        throw new Error(`Product not found: ${r.Item}`);
      }

      const productId = p.rows[0].productid;

      // Sales details
      await client.query(
        `
        INSERT INTO tblsalesdetails
        (salesid, productid, item, quantity, series, category)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [salesId, productId, r.Item, r.Quantity, r.SeriesName, r.CategoryName]
      );

      // Stock ledger
      await client.query(
        `
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname, quantity, locationname, username)
        VALUES ('OUT', $1, $2, $3, $4, $5, $6, $7)
        `,
        [
          salesId,
          r.Item,
          r.SeriesName,
          r.CategoryName,
          r.Quantity,
          Location,
          UserName
        ]
      );

      // Stock update
      await client.query(
        `
        UPDATE tblstock
        SET totalquantity = totalquantity - $1
        WHERE productid = $2
        `,
        [r.Quantity, productId]
      );
    }

    // 4️⃣ COMMIT TRANSACTION
    await client.query("COMMIT");

    // 5️⃣ ACTIVITY LOG
    await logActivity({
      userId: userId,
      username: UserName,
      actionType: "SALES",
      description: "Sales entry created"
    });

    // 🔔 6️⃣ SALES NOTIFICATION (ADMIN ONLY)
    try {
      await notifyAdminSale({
        createdByName,
        customerName: Customer,
        location: Location,
        salesId
      });
    } catch (err) {
      console.error("Sales notification failed:", err);
      // do NOT block API
    }

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Sales error:", e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});
// ----------------------------------------------------------
// STOCK TRANSFER  (ALIGNED WITH INCOMING / SALES)
// ----------------------------------------------------------
app.post("/stock/transfer", async (req, res) => {
  const client = await pool.connect();

  try {
    const { UserName, FromLocation, ToLocation, Rows } = req.body;

    if (
      !UserName ||
      !FromLocation ||
      !ToLocation ||
      FromLocation === ToLocation ||
      !Array.isArray(Rows) ||
      Rows.length === 0
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    await client.query("BEGIN");

    // Header (same pattern as incoming / sales)
    const h = await client.query(`
      INSERT INTO tblstocktransferheader
      (fromlocation, tolocation, username)
      VALUES ($1,$2,$3)
      RETURNING transferid
    `, [FromLocation, ToLocation, UserName]);

    const transferId = h.rows[0].transferid;

    for (const r of Rows) {

      const p = await client.query(`
        SELECT productid
        FROM tblproduct
        WHERE item=$1 AND seriesname=$2 AND categoryname=$3
      `, [r.Item, r.SeriesName, r.CategoryName]);

      if (p.rows.length === 0)
        throw new Error(`Product not found: ${r.Item}`);

      // OUT (source)
      await client.query(`
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES
        ('OUT', $1, $2, $3, $4, $5, $6, $7)
      `, [
        transferId,
        r.Item,
        r.SeriesName,
        r.CategoryName,
        r.Quantity,
        FromLocation,
        UserName
      ]);

      // INCOMING (destination)
      await client.query(`
        INSERT INTO tblstockledger
        (movementtype, referenceid, item, seriesname, categoryname,
         quantity, locationname, username)
        VALUES
        ('Incoming', $1, $2, $3, $4, $5, $6, $7)
      `, [
        transferId,
        r.Item,
        r.SeriesName,
        r.CategoryName,
        r.Quantity,
        ToLocation,
        UserName
      ]);
    }

    await client.query("COMMIT");

    await logActivity({
      username: UserName,
      actionType: "STOCK_TRANSFER",
      description: `${FromLocation} → ${ToLocation}`
    });

    res.json({ success: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("STOCK TRANSFER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post("/admin/notify-app-update", async (req, res) => {
  try {
    await notifyAppUpdate();
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 1: INCOMING LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/incoming/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.incomingheaderid AS "ID",
        h.enteredat        AS "Date",
        h.location         AS "Location",
        COALESCE(SUM(d.quantity), 0) AS "TotalQty"
      FROM tblincomingheader h
      JOIN tblincomingdetails d
        ON d.incomingheaderid = h.incomingheaderid
      GROUP BY h.incomingheaderid, h.enteredat, h.location
      ORDER BY h.incomingheaderid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("INCOMING LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ----------------------------------------------------------
// STEP 2: SALES LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/sales/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.salesid      AS "ID",
        h."date"       AS "Date",
        h.customer     AS "Customer",
        COALESCE(SUM(d.quantity), 0) AS "TotalQty"
      FROM tblsalesheader h
      JOIN tblsalesdetails d
        ON d.salesid = h.salesid
      GROUP BY h.salesid, h."date", h.customer
      ORDER BY h.salesid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("SALES LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 3: STOCK TRANSFER LIST (READ-ONLY, VOUCHER LEVEL)
// ----------------------------------------------------------
app.get("/stock/transfer/list", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        h.transferid   AS "ID",
        h.createdon    AS "Date",
        h.fromlocation AS "FromLocation",
        h.tolocation   AS "ToLocation",
        COALESCE(SUM(l.quantity), 0) AS "TotalQty"
      FROM tblstocktransferheader h
      LEFT JOIN tblstockledger l
        ON l.referenceid = h.transferid
       AND l.movementtype = 'Incoming'
      GROUP BY
        h.transferid,
        h.createdon,
        h.fromlocation,
        h.tolocation
      ORDER BY h.transferid DESC
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("TRANSFER LIST ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 4: VIEW SINGLE INCOMING VOUCHER (READ-ONLY)
// ----------------------------------------------------------
app.get("/incoming/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const header = await pool.query(`
      SELECT
        incomingheaderid,
        username,
        location,
        enteredat
      FROM tblincomingheader
      WHERE incomingheaderid = $1
    `, [id]);

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const rows = await pool.query(`
      SELECT
        item,
        seriesname,
        categoryname,
        quantity
      FROM tblincomingdetails
      WHERE incomingheaderid = $1
      ORDER BY incomingdetailid
    `, [id]);

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW INCOMING ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 5: VIEW SINGLE SALES VOUCHER (READ-ONLY)
// ----------------------------------------------------------
app.get("/sales/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const header = await pool.query(`
      SELECT
        salesid,
        username,
        locationname,
        "date",
        customer,
        voucherno
      FROM tblsalesheader
      WHERE salesid = $1
    `, [id]);

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const rows = await pool.query(`
      SELECT
        item,
        series,
        category,
        quantity
      FROM tblsalesdetails
      WHERE salesid = $1
      ORDER BY salesdetailid
    `, [id]);

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW SALES ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// ----------------------------------------------------------
// STEP 6: VIEW SINGLE STOCK TRANSFER (READ-ONLY)
// ----------------------------------------------------------
app.get("/stock/transfer/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Header
    const header = await pool.query(`
      SELECT
        transferid,
        fromlocation,
        tolocation,
        username,
        createdon
      FROM tblstocktransferheader
      WHERE transferid = $1
    `, [id]);

    if (header.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    // Rows (ledger entries)
    const rows = await pool.query(`
      SELECT
        item,
        seriesname,
        categoryname,
        quantity,
        locationname,
        movementtype
      FROM tblstockledger
      WHERE referenceid = $1
      ORDER BY ledgerid
    `, [id]);

    res.json({
      header: header.rows[0],
      rows: rows.rows
    });

  } catch (e) {
    console.error("VIEW TRANSFER ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------
// APP UPDATE (IN-APP UPDATE CHECK)
// ----------------------------------------------------------
app.get("/app/update", (req, res) => {
  res.json({
    latest_version_code: 12,
    force_update: false,
    download_url: "https://drive.google.com/file/d/1QzHIdeg23D7JluIw1p6hizMH3P7snwkO"
  });
});

// ----------------------------------------------------------
// START
// ----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 Karni API running on ${PORT}`)
);
