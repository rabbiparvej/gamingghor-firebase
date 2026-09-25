const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 20 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const WALLET_FIELD = {
  BDT: 'walletBalance',
  SAR: 'walletBalanceSAR',
  USD: 'walletBalanceUSD',
};

function requireAuth(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Login required.');
  return uid;
}

function money2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cleanCode(value) {
  return String(value || '').trim().toUpperCase();
}

async function requireAdmin(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().role !== 'admin' || snap.data().status === 'BANNED') {
    throw new HttpsError('permission-denied', 'Admin permission required.');
  }
  return snap.data();
}

function assertActiveUser(data) {
  if (!data || ['BANNED', 'DISABLED'].includes(String(data.status || '').toUpperCase())) {
    throw new HttpsError('permission-denied', 'This account is disabled.');
  }
}

/* =========================================================
   1) CASH COUPON REDEEM
   ========================================================= */
exports.redeemCashCoupon = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = cleanCode(request.data?.code);
  if (!/^[A-Z0-9_-]{3,80}$/.test(code)) {
    throw new HttpsError('invalid-argument', 'Invalid coupon code.');
  }

  const couponRef = db.doc(`coupons/${code}`);
  const redemptionRef = db.doc(`couponRedemptions/${code}_${uid}`);
  const userRef = db.doc(`users/${uid}`);
  const transactionRef = db.collection('walletTransactions').doc();

  const result = await db.runTransaction(async (tx) => {
    const [couponSnap, redemptionSnap, userSnap] = await Promise.all([
      tx.get(couponRef),
      tx.get(redemptionRef),
      tx.get(userRef),
    ]);

    if (!couponSnap.exists) throw new HttpsError('not-found', 'Coupon not found.');
    if (redemptionSnap.exists) throw new HttpsError('already-exists', 'Coupon already redeemed.');
    if (!userSnap.exists) throw new HttpsError('failed-precondition', 'User profile not found.');

    const coupon = couponSnap.data();
    const user = userSnap.data();
    assertActiveUser(user);

    if (coupon.type !== 'CASH' || coupon.active === false) {
      throw new HttpsError('failed-precondition', 'This is not an active cash coupon.');
    }

    const currency = String(coupon.currency || '').toUpperCase();
    const walletField = WALLET_FIELD[currency];
    const amount = money2(coupon.amount);
    const maxUses = Number(coupon.maxUses);
    const usedCount = Number(coupon.usedCount || 0);

    if (!walletField || !Number.isFinite(amount) || amount <= 0) {
      throw new HttpsError('failed-precondition', 'Invalid coupon configuration.');
    }
    if (!Number.isInteger(maxUses) || maxUses < 1 || usedCount >= maxUses) {
      throw new HttpsError('failed-precondition', 'Coupon usage limit reached.');
    }

    const currentBalance = Number(user[walletField] || 0);
    if (!Number.isFinite(currentBalance)) {
      throw new HttpsError('failed-precondition', 'Invalid wallet balance.');
    }

    tx.update(userRef, {
      [walletField]: money2(currentBalance + amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(couponRef, {
      usedCount: usedCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(redemptionRef, {
      couponId: code,
      couponCode: code,
      type: 'CASH',
      userId: uid,
      amount,
      currency,
      redeemedAt: FieldValue.serverTimestamp(),
    });
    tx.create(transactionRef, {
      userId: uid,
      amount,
      currency,
      type: 'COUPON_REWARD',
      couponCode: code,
      description: `Cash coupon ${code} redeemed`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { amount, currency };
  });

  return { ok: true, ...result };
});

/* =========================================================
   2) REFERRAL CLAIM
   ========================================================= */
exports.claimReferral = onCall(async (request) => {
  const uid = requireAuth(request);
  const referralCode = String(request.data?.referralCode || '').trim();

  if (!/^\d{8}$/.test(referralCode)) {
    throw new HttpsError('invalid-argument', 'Referral code must be 8 digits.');
  }

  const codeSnap = await db.doc(`userCodes/${referralCode}`).get();
  if (!codeSnap.exists) throw new HttpsError('not-found', 'Referral code not found.');

  const referrerUid = codeSnap.data().uid;
  if (!referrerUid || referrerUid === uid) {
    throw new HttpsError('failed-precondition', 'Invalid self-referral.');
  }

  const userRef = db.doc(`users/${uid}`);
  const referrerRef = db.doc(`users/${referrerUid}`);
  const referralRef = db.doc(`referrals/${uid}`);

  await db.runTransaction(async (tx) => {
    const [userSnap, referrerSnap, existingReferralSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(referrerRef),
      tx.get(referralRef),
    ]);

    if (!userSnap.exists || !referrerSnap.exists) {
      throw new HttpsError('not-found', 'User profile not found.');
    }
    if (existingReferralSnap.exists) {
      throw new HttpsError('already-exists', 'Referral already claimed.');
    }

    const user = userSnap.data();
    const referrer = referrerSnap.data();
    assertActiveUser(user);
    assertActiveUser(referrer);

    if (user.referralCodeUsed || user.referrerUid || user.referredByUid) {
      throw new HttpsError('already-exists', 'Referral already claimed.');
    }

    tx.update(userRef, {
      referralCodeUsed: true,
      referrerUid,
      referredByUid: referrerUid,
      referredByCode: referralCode,
      referralLinkedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.create(referralRef, {
      refereeUid: uid,
      referrerUid,
      referrerCode: referralCode,
      source: 'EARN',
      linkedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true, referrerUid };
});

/* =========================================================
   3) SECURE ORDER CREATION WITH DISCOUNT COUPON
   The server calculates the price and wallet deduction.
   The browser is not trusted for price, discount or balance.
   ========================================================= */
exports.createOrder = onCall(async (request) => {
  const uid = requireAuth(request);
  const packageId = String(request.data?.packageId || '').trim();
  const targetInput = String(request.data?.targetInput || '').trim();
  const currency = String(request.data?.currency || 'BDT').toUpperCase();
  const couponCode = cleanCode(request.data?.couponCode);

  if (!packageId || !targetInput) {
    throw new HttpsError('invalid-argument', 'Package and target are required.');
  }
  if (!WALLET_FIELD[currency]) {
    throw new HttpsError('invalid-argument', 'Invalid currency.');
  }

  const userRef = db.doc(`users/${uid}`);
  const packageRef = db.doc(`packages/${packageId}`);
  const couponRef = couponCode ? db.doc(`coupons/${couponCode}`) : null;
  const redemptionRef = couponCode
    ? db.doc(`couponRedemptions/${couponCode}_${uid}`)
    : null;
  const orderRef = db.collection('orders').doc();
  const ledgerRef = db.collection('walletTransactions').doc();
  const slipNumber = `#${Math.floor(10000000 + Math.random() * 90000000)}`;

  const result = await db.runTransaction(async (tx) => {
    const reads = [tx.get(userRef), tx.get(packageRef)];
    if (couponRef) reads.push(tx.get(couponRef), tx.get(redemptionRef));
    const snaps = await Promise.all(reads);

    const userSnap = snaps[0];
    const packageSnap = snaps[1];
    if (!userSnap.exists) throw new HttpsError('not-found', 'User profile not found.');
    if (!packageSnap.exists) throw new HttpsError('not-found', 'Package not found.');

    const user = userSnap.data();
    const pkg = packageSnap.data();
    assertActiveUser(user);
    if (pkg.soldOut === true || pkg.availability === 'SOLD_OUT') {
      throw new HttpsError('failed-precondition', 'Package is sold out.');
    }

    let basePrice;
    if (currency === 'USD') basePrice = Number(pkg.priceUSD ?? Number(pkg.price || 0) * 0.0083);
    else if (currency === 'SAR') basePrice = Number(pkg.priceSAR ?? Number(pkg.price || 0) * 0.033);
    else basePrice = Number(pkg.price);

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      throw new HttpsError('failed-precondition', 'Invalid package price.');
    }
    basePrice = money2(basePrice);

    let finalPrice = basePrice;
    let discountAmount = 0;
    let discountPercent = 0;

    if (couponRef) {
      const couponSnap = snaps[2];
      const redemptionSnap = snaps[3];
      if (!couponSnap.exists) throw new HttpsError('not-found', 'Discount coupon not found.');
      if (redemptionSnap.exists) throw new HttpsError('already-exists', 'Coupon already used.');

      const coupon = couponSnap.data();
      const usedCount = Number(coupon.usedCount || 0);
      const maxUses = Number(coupon.maxUses);
      discountPercent = Number(coupon.percent);

      if (coupon.type !== 'DISCOUNT' || coupon.active === false) {
        throw new HttpsError('failed-precondition', 'Invalid or inactive discount coupon.');
      }
      if (!Number.isInteger(maxUses) || usedCount >= maxUses) {
        throw new HttpsError('failed-precondition', 'Coupon usage limit reached.');
      }
      if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
        throw new HttpsError('failed-precondition', 'Invalid discount configuration.');
      }

      discountAmount = money2(basePrice * discountPercent / 100);
      finalPrice = money2(Math.max(0, basePrice - discountAmount));

      tx.update(couponRef, {
        usedCount: usedCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(redemptionRef, {
        couponId: couponCode,
        couponCode,
        type: 'DISCOUNT',
        userId: uid,
        orderId: orderRef.id,
        percent: discountPercent,
        discountAmount,
        currency,
        redeemedAt: FieldValue.serverTimestamp(),
      });
    }

    const walletField = WALLET_FIELD[currency];
    const balance = Number(user[walletField] || 0);
    if (!Number.isFinite(balance) || balance < finalPrice) {
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance.');
    }

    tx.update(userRef, {
      [walletField]: money2(balance - finalPrice),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(orderRef, {
      slipNumber,
      userId: uid,
      userEmail: request.auth.token.email || '',
      userName: user.displayName || request.auth.token.name || 'User',
      packageId,
      packageName: pkg.name || 'Package',
      itemId: pkg.itemId || '',
      productId: pkg.productId || '',
      targetInput,
      price: finalPrice,
      originalPrice: basePrice,
      discountAmount,
      discountCouponCode: couponCode || null,
      discountPercent,
      currency,
      status: 'PENDING',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(ledgerRef, {
      userId: uid,
      amount: finalPrice,
      currency,
      type: 'DEDUCTION',
      orderId: orderRef.id,
      description: `Order purchase: ${pkg.name || packageId}`,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { orderId: orderRef.id, slipNumber, price: finalPrice, currency };
  });

  return { ok: true, ...result };
});

/* Optional helper for an admin-only callable. */
exports.testAdminAccess = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireAdmin(uid);
  return { ok: true };
});

