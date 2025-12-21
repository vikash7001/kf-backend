const admin = require("./firebase");
const { pool } = require("./db");

/* ======================================================
   🔔 LOGIN NOTIFICATION (ADMIN ONLY)
====================================================== */
async function notifyAdminLogin(fullname) {
  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE role = 'Admin'"
  );
  if (!admins.rows.length) return;

  const adminIds = admins.rows.map(r => r.userid);

  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [adminIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body: `User login\nUser: ${fullname}`
    },
    tokens
  });
}

/* ======================================================
   🔔 SALES NOTIFICATION (ADMIN ONLY)
====================================================== */
async function notifyAdminSale({
  createdByName,
  customerName,
  location,
  salesId
}) {
  console.log("🔥 notifyAdminSale ENTERED", salesId);

  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE role = 'Admin'"
  );
  if (!admins.rows.length) return;

  const adminIds = admins.rows.map(r => r.userid);

  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [adminIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

  const pcsResult = await pool.query(
    `
    SELECT COALESCE(SUM(quantity), 0) AS total_pcs
    FROM tblsalesdetails
    WHERE salesid = $1
    `,
    [salesId]
  );

  const totalPcs = pcsResult.rows[0].total_pcs;
  console.log("🔥 SALES PCS:", totalPcs);

  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body:
        `Sale created\n` +
        `By: ${createdByName}\n` +
        `Customer: ${customerName}\n` +
        `Location: ${location}\n` +
        `Total PCS: ${totalPcs}`
    },
    tokens
  });

  console.log("🔥 SALES NOTIFICATION SENT");
}

/* ======================================================
   🔔 INCOMING NOTIFICATION (ADMIN + USER)
====================================================== */
async function notifyIncoming({
  createdByName,
  location,
  incomingHeaderId
}) {
  const users = await pool.query(
    "SELECT userid FROM tblusers WHERE role IN ('Admin','User')"
  );
  if (!users.rows.length) return;

  const userIds = users.rows.map(r => r.userid);

  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [userIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

  const pcsResult = await pool.query(
    `
    SELECT COALESCE(SUM(quantity),0) AS total_pcs
    FROM tblincomingdetails
    WHERE incomingheaderid = $1
    `,
    [incomingHeaderId]
  );

  const totalPcs = pcsResult.rows[0].total_pcs;

  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body:
        `Incoming created\n` +
        `By: ${createdByName}\n` +
        `Location: ${location}\n` +
        `Total PCS: ${totalPcs}`
    },
    tokens
  });
}
async function notifyAppUpdate() {
  const message = {
    topic: "app_updates",
    notification: {
      title: "App Update Available",
      body: "A new version is available. Tap to download."
    },
    data: {
      url: "https://drive.google.com/uc?id=1QzHIdeg23D7JluIw1p6hizMH3P7snwkO&export=download"
    }
  };

  await admin.messaging().send(message);
}

/* ======================================================
   ✅ EXPORTS
====================================================== */
module.exports = {
  notifyAdminLogin,
  notifyAdminSale,
  notifyIncoming,
  notifyAppUpdate
};
