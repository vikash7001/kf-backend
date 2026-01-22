const admin = require("./firebase");
const { pool } = require("./db");

/* ======================================================
   🔔 LOGIN NOTIFICATION (ADMIN ONLY)
====================================================== */
async function notifyAdminLogin(fullname) {
  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE UPPER(role) = 'ADMIN'"
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
  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE UPPER(role) = 'ADMIN'"
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
    "SELECT userid FROM tblusers WHERE UPPER(role) IN ('ADMIN','USER')"
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
    SELECT COALESCE(SUM(quantity), 0) AS total_pcs
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

/* ======================================================
   🔔 APP UPDATE NOTIFICATION (ALL USERS – TOPIC)
====================================================== */
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
   🔔 NEW IMAGE ADDED (ALL USERS)
   Includes IMAGE + SERIES + ITEM
====================================================== */
async function notifyNewImage({
  imageUrl,
  seriesName,
  itemName
}) {
  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens"
  );

  const tokens = tokensResult.rows
    .map(r => r.token)
    .filter(Boolean);

  if (!tokens.length) return;

await admin.messaging().sendEachForMulticast({
  notification: {
    title: "New Design Added ✨",
    body: `Series: ${seriesName}\nItem: ${itemName}`,
    image: imageUrl
  },
  data: {
    type: "image",
    series: seriesName,
    item: itemName,
    imageUrl: imageUrl
  },
  android: {
    priority: "high"
  },
  tokens
});

}
/* ======================================================
   ✅ EXPORTS
====================================================== */
module.exports = {
  notifyAdminLogin,
  notifyAdminSale,
  notifyIncoming,
  notifyAppUpdate,
  notifyNewImage
};
