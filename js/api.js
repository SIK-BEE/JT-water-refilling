import { auth, db, firebaseConfig } from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut, deleteUser } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";


// Uses a secondary Firebase Auth instance so creating customer/staff/driver accounts
// does not sign the current Admin out. No privileged server key is used.
export async function apiCreateUserAccount({ email, password, fullName, phoneNumber, address = '', role }) {
    if (!auth.currentUser) throw new Error("Please sign in again.");
    if (!['customer', 'staff', 'driver'].includes(role)) throw new Error("Choose a supported account role.");
    if (!String(fullName || '').trim()) throw new Error('Full name is required.');
    if (!String(phoneNumber || '').trim()) throw new Error('Phone number is required.');
    if (role === 'customer' && !String(address || '').trim()) throw new Error('Customer delivery address is required.');
    const adminProfile = await getDoc(doc(db, 'users', auth.currentUser.uid));
    if (!adminProfile.exists() || adminProfile.data().role !== 'admin') throw new Error("Only Admin can create accounts.");

    const secondaryApp = initializeApp(firebaseConfig, `staff-creator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const secondaryAuth = getAuth(secondaryApp);
    let createdUser = null;
    try {
        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        createdUser = credential.user;
        const profile = {
            uid: createdUser.uid, email, fullName, phoneNumber, role,
            createdAt: serverTimestamp(), isActive: true
        };
        if (role === 'customer') {
            profile.address = String(address || '').trim();
            profile.status = 'approved';
            profile.approvedAt = serverTimestamp();
            profile.approvedBy = auth.currentUser.uid;
        }
        await setDoc(doc(db, 'users', createdUser.uid), profile);
        await signOut(secondaryAuth);
        return { success: true, uid: createdUser.uid };
    } catch (error) {
        if (createdUser && secondaryAuth.currentUser) {
            try { await deleteUser(secondaryAuth.currentUser); } catch (_) {}
        }
        throw error;
    } finally {
        await deleteApp(secondaryApp);
    }
}

function makeReceiptNumber(orderId) {
    // Receipt date follows the station's Philippine local date, not UTC.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(p => p.type === type)?.value || '00';
    const date = `${part('year')}${part('month')}${part('day')}`;
    return `JT-${date}-${String(orderId).toUpperCase()}`;
}

export async function apiApproveGCashPayment(paymentId, orderId) {
    const actor = auth.currentUser;
    if (!actor) throw new Error('Please sign in again.');
    const paymentRef = doc(db, 'payments', paymentId);
    const orderRef = doc(db, 'orders', orderId);
    const saleRef = doc(db, 'sales', orderId);
    const receiptRef = doc(db, 'receipts', orderId);
    const receiptNumber = makeReceiptNumber(orderId);

    await runTransaction(db, async (tx) => {
        const [paymentSnap, orderSnap, saleSnap, receiptSnap, profileSnap] = await Promise.all([
            tx.get(paymentRef), tx.get(orderRef), tx.get(saleRef), tx.get(receiptRef), tx.get(doc(db, 'users', actor.uid))
        ]);
        if (!profileSnap.exists() || profileSnap.data().role !== 'admin') throw new Error('Only Admin/Owner can verify GCash payments.');
        if (!paymentSnap.exists() || !orderSnap.exists()) throw new Error('Payment or order was not found.');
        if (saleSnap.exists() || receiptSnap.exists()) throw new Error('This order already has an official sale or receipt.');
        const payment = paymentSnap.data();
        const order = orderSnap.data();
        if (payment.status !== 'pending' || payment.method !== 'online' || order.paymentMethod !== 'online') throw new Error('This payment is not pending GCash verification.');
        if (order.paymentStatus === 'paid') throw new Error('This order is already paid.');
        tx.update(paymentRef, { status: 'approved', verifiedBy: actor.uid, updatedAt: serverTimestamp() });
        tx.update(orderRef, { paymentStatus: 'paid', updatedAt: serverTimestamp() });
        tx.set(saleRef, { id: orderId, orderId, paymentId, amount: order.totalAmount, paymentMethod: 'online', confirmedBy: actor.uid, createdAt: serverTimestamp() });
        tx.set(receiptRef, {
            id: orderId, saleId: orderId, orderId, receiptNumber,
            customerDetails: { uid: order.customerId, name: order.customerName },
            items: order.items, totalAmount: order.totalAmount, createdAt: serverTimestamp()
        });
    });
    return { success: true, receiptNumber };
}

export async function apiRejectGCashPayment(paymentId, orderId, reason = '') {
    const actor = auth.currentUser;
    if (!actor) throw new Error('Please sign in again.');
    await runTransaction(db, async (tx) => {
        const paymentRef = doc(db, 'payments', paymentId);
        const orderRef = doc(db, 'orders', orderId);
        const [p, o, profile] = await Promise.all([tx.get(paymentRef), tx.get(orderRef), tx.get(doc(db, 'users', actor.uid))]);
        if (!profile.exists() || profile.data().role !== 'admin') throw new Error('Only Admin/Owner can reject GCash payments.');
        if (!p.exists() || !o.exists() || p.data().status !== 'pending') throw new Error('This payment is no longer pending.');
        tx.update(paymentRef, { status: 'rejected', rejectionReason: reason, verifiedBy: actor.uid, updatedAt: serverTimestamp() });
        tx.update(orderRef, { paymentStatus: 'unpaid', updatedAt: serverTimestamp() });
    });
    return { success: true };
}

export async function apiCompletePickupOrder(orderId) {
    const actor = auth.currentUser;
    if (!actor) throw new Error('Please sign in again.');
    const orderRef = doc(db, 'orders', orderId);
    const saleRef = doc(db, 'sales', orderId);
    const receiptRef = doc(db, 'receipts', orderId);
    const paymentRef = doc(db, 'payments', orderId);
    const receiptNumber = makeReceiptNumber(orderId);

    await runTransaction(db, async (tx) => {
        const [orderSnap, saleSnap, receiptSnap, paymentSnap, profileSnap] = await Promise.all([
            tx.get(orderRef), tx.get(saleRef), tx.get(receiptRef),
            tx.get(paymentRef), tx.get(doc(db, 'users', actor.uid))
        ]);
        if (!profileSnap.exists() || !['admin', 'staff'].includes(profileSnap.data().role)) {
            throw new Error('Only Staff or Admin can confirm customer pickup.');
        }
        if (!orderSnap.exists()) throw new Error('Order not found.');
        const order = orderSnap.data();
        if (order.type !== 'pickup') throw new Error('This is not a pickup order.');
        if (order.deliveryStatus !== 'ready_for_pickup') throw new Error('The order must be Ready for Pickup first.');

        if (order.paymentMethod === 'online') {
            if (order.paymentStatus !== 'paid' || !saleSnap.exists() || !receiptSnap.exists()) {
                throw new Error('Verify the GCash payment before completing this pickup.');
            }
            tx.update(orderRef, { deliveryStatus: 'completed', updatedAt: serverTimestamp() });
            return;
        }

        if (order.paymentMethod !== 'cod') throw new Error('Unsupported payment method.');
        if (order.paymentStatus === 'paid' || saleSnap.exists() || receiptSnap.exists() || paymentSnap.exists()) {
            throw new Error('This order is already paid or recorded. Refresh the order list.');
        }

        tx.update(orderRef, {
            paymentStatus: 'paid',
            deliveryStatus: 'completed',
            updatedAt: serverTimestamp()
        });
        tx.set(paymentRef, {
            id: orderId, orderId, customerId: order.customerId, method: 'cod',
            amount: order.totalAmount, status: 'approved', verifiedBy: actor.uid,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        tx.set(saleRef, {
            id: orderId, orderId, paymentId: orderId, amount: order.totalAmount,
            paymentMethod: 'cod', confirmedBy: actor.uid, createdAt: serverTimestamp()
        });
        tx.set(receiptRef, {
            id: orderId, saleId: orderId, orderId, receiptNumber,
            customerDetails: { uid: order.customerId, name: order.customerName },
            items: order.items, totalAmount: order.totalAmount, createdAt: serverTimestamp()
        });
    });
    return { success: true, receiptNumber };
}

export async function apiConfirmCODPayment(orderId) {
    const actor = auth.currentUser;
    if (!actor) throw new Error('Please sign in again.');
    const orderRef = doc(db, 'orders', orderId);
    const saleRef = doc(db, 'sales', orderId);
    const receiptRef = doc(db, 'receipts', orderId);
    const paymentRef = doc(db, 'payments', orderId);
    const receiptNumber = makeReceiptNumber(orderId);

    await runTransaction(db, async (tx) => {
        const [orderSnap, saleSnap, receiptSnap, profileSnap] = await Promise.all([
            tx.get(orderRef), tx.get(saleRef), tx.get(receiptRef), tx.get(doc(db, 'users', actor.uid))
        ]);
        if (!profileSnap.exists() || !['admin', 'staff', 'driver'].includes(profileSnap.data().role)) throw new Error('Only Staff, Driver, or Admin can confirm received cash.');
        if (!orderSnap.exists()) throw new Error('Order not found.');
        const order = orderSnap.data();
        if (order.paymentMethod !== 'cod') throw new Error('This order is not COD.');
        if (profileSnap.data().role === 'driver' && order.assignedDriverId !== actor.uid) {
            throw new Error('Drivers can confirm cash only for deliveries assigned to them.');
        }
        if (order.paymentStatus === 'paid' || saleSnap.exists() || receiptSnap.exists()) throw new Error('This order is already paid or recorded.');
        tx.update(orderRef, { paymentStatus: 'paid', deliveryStatus: order.type === 'delivery' ? 'completed' : order.deliveryStatus, updatedAt: serverTimestamp() });
        tx.set(paymentRef, { id: orderId, orderId, customerId: order.customerId, method: 'cod', amount: order.totalAmount, status: 'approved', verifiedBy: actor.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        tx.set(saleRef, { id: orderId, orderId, paymentId: orderId, amount: order.totalAmount, paymentMethod: 'cod', confirmedBy: actor.uid, createdAt: serverTimestamp() });
        tx.set(receiptRef, { id: orderId, saleId: orderId, orderId, receiptNumber, customerDetails: { uid: order.customerId, name: order.customerName }, items: order.items, totalAmount: order.totalAmount, createdAt: serverTimestamp() });
    });
    return { success: true, receiptNumber };
}

// Assign a delivery order to a Driver (Admin only)
export async function apiAssignDriver(orderId, driverId) {
    const actor = auth.currentUser;

    if (!actor) {
        throw new Error("Please sign in again.");
    }

    if (!orderId || !driverId) {
        throw new Error("Please select an order and a Driver.");
    }

    const adminSnap = await getDoc(
        doc(db, "users", actor.uid)
    );

    if (!adminSnap.exists() || adminSnap.data().role !== "admin") {
        throw new Error("Only Admin can assign Drivers.");
    }

    const driverSnap = await getDoc(
        doc(db, "users", driverId)
    );

    if (
        !driverSnap.exists() ||
        driverSnap.data().role !== "driver" ||
        driverSnap.data().isActive !== true
    ) {
        throw new Error("The selected Driver is invalid or inactive.");
    }

    const orderRef = doc(db, "orders", orderId);
    const orderSnap = await getDoc(orderRef);

    if (!orderSnap.exists()) {
        throw new Error("Order not found.");
    }

    const order = orderSnap.data();

    if (order.type !== "delivery") {
        throw new Error("Only delivery orders can be assigned.");
    }
    if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid') {
        throw new Error("Verify the GCash payment before assigning this delivery.");
    }

    if (order.deliveryStatus === "completed") {
        throw new Error("This delivery is already completed.");
    }

    
    await updateDoc(orderRef, {
        assignedDriverId: driverId,
        updatedAt: serverTimestamp()
    });

    return { success: true };
}
