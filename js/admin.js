import { auth, db } from "./firebase-init.js";

const statusLabel = status => ({pending:'Pending',accepted:'Confirmed',preparing:'Processing',processing:'Processing',ready_for_pickup:'Ready for Pickup',ready_for_dispatch:'Ready for Dispatch',out_for_delivery:'Out for Delivery',delivered:'Delivered',completed:'Completed',failed:'Delivery Failed',cancelled:'Cancelled',unpaid:'Unpaid',pending_verification:'Verifying Payment',paid:'Paid',rejected:'Payment Rejected',refund_pending:'Refund Pending',refunded:'Refunded',cod:'Cash on Delivery',online:'GCash',gcash:'GCash'}[String(status||'pending').toLowerCase()] || String(status||'pending').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()));
import { collection, getDocs, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, deleteField, runTransaction, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    apiCreateUserAccount,
    apiApproveGCashPayment,
    apiRejectGCashPayment,
    apiAssignDriver,
    apiCreateWalkInOrder
} from "./api.js";

export async function initAdminDashboard(){
    const nav=document.getElementById('sidebar-nav');
    nav.innerHTML=`<a href="#" class="nav-link active" data-target="overview"><span class="nav-icon" aria-hidden="true">▦</span><span>Sales Overview</span></a><a href="#" class="nav-link" data-target="accounts"><span class="nav-icon" aria-hidden="true">♙</span><span>Accounts</span><span class="badge badge-warning" id="pending-customers-badge">…</span></a><a href="#" class="nav-link" data-target="products"><span class="nav-icon" aria-hidden="true">▣</span><span>Products & Prices</span></a><a href="#" class="nav-link" data-target="verify-payments"><span class="nav-icon" aria-hidden="true">▤</span><span>GCash Payment Verification / Official Receipt</span><span class="badge badge-warning" id="pending-payments-badge" style="display:none">0</span></a><a href="#" class="nav-link" data-target="cancellation-requests"><span class="nav-icon" aria-hidden="true">↩</span><span>Cancellation Request / Records</span><span class="badge badge-warning" id="pending-cancellations-badge" style="display:none">0</span></a>`;
    setupNav(); loadOverview(); refreshPendingCustomerBadge(); listenForNewCustomerRequests(); listenForPendingPayments(); listenForCancellationRequests();
}

// Keep the Admin badge and Customers tab live while the dashboard is open.
// Compare the live snapshot with a baseline so a registration that arrives while
// the listener's first snapshot is loading is not silently treated as old data.
async function listenForNewCustomerRequests() {
    if (window.__jtCustomerRequestsUnsubscribe) window.__jtCustomerRequestsUnsubscribe();

    let knownUserIds = new Set();
    try {
        const baseline = await getDocs(collection(db, 'users'));
        baseline.forEach(item => knownUserIds.add(item.id));
    } catch (error) {
        // Still start the live listener; its error handler will surface access/connectivity issues.
        console.warn('Could not establish customer notification baseline:', error);
    }

    window.__jtCustomerRequestsUnsubscribe = onSnapshot(collection(db, 'users'), snapshot => {
        let newestName = '';
        const newRequests = [];

        // Inspect all documents in the snapshot, not only docChanges(), because a
        // new registration can arrive before Firestore delivers the first snapshot.
        snapshot.forEach(item => {
            const user = item.data();
            const isNew = !knownUserIds.has(item.id);
            if (isNew && user.role === 'customer' && user.status === 'pending' && user.isActive !== false) {
                newRequests.push(user);
            }
            knownUserIds.add(item.id);
        });

        refreshPendingCustomerBadge();
        if (newRequests.length) {
            newestName = newRequests[newRequests.length - 1].fullName || newRequests[newRequests.length - 1].email || 'A customer';
            window.showToast(`New customer registration: ${newestName}. Open Customers to review.`, 'info', 9000);
            if (document.querySelector('.nav-link.active')?.dataset.target === 'accounts' && window.__jtAccountsTab !== 'team') loadCustomers();
        }
    }, error => {
        console.error('Customer request listener failed:', error);
        window.showToast('Live customer notifications could not connect. Open Customers to refresh manually.', 'error', 7000);
    });
}


// Count only payments that are genuinely actionable in the verification queue.
// Cancellation-pending, cancelled, and already-refunded orders must not inflate the badge.
function listenForPendingPayments() {
    if (window.__jtPendingPaymentsUnsubscribe) window.__jtPendingPaymentsUnsubscribe();
    if (window.__jtPendingPaymentOrdersUnsubscribe) window.__jtPendingPaymentOrdersUnsubscribe();
    let paymentsById = new Map();
    let ordersById = new Map();
    const renderCount = () => {
        const actionableOrderIds = new Set();
        paymentsById.forEach(p => {
            if (String(p.method || '').toLowerCase() !== 'online' || String(p.status || '').toLowerCase() !== 'pending') return;
            const orderId = String(p.orderId || p.id);
            const order = ordersById.get(orderId) || ordersById.get(p.id) || {};
            if (String(order.cancellationRequestStatus || '').toLowerCase() === 'pending') return;
            if (String(order.deliveryStatus || '').toLowerCase() === 'cancelled') return;
            if (String(order.refundStatus || '').toLowerCase() === 'completed') return;
            actionableOrderIds.add(orderId);
        });
        const count = actionableOrderIds.size;
        const badge = document.getElementById('pending-payments-badge');
        if (badge) { badge.textContent = String(count); badge.style.display = count ? 'inline-flex' : 'none'; }
    };
    window.__jtPendingPaymentsUnsubscribe = onSnapshot(collection(db, 'payments'), snapshot => {
        paymentsById = new Map(snapshot.docs.map(item => [item.id, { id: item.id, ...item.data() }]));
        renderCount();
    }, error => console.error('Pending payment badge listener failed:', error));
    window.__jtPendingPaymentOrdersUnsubscribe = onSnapshot(collection(db, 'orders'), snapshot => {
        ordersById = new Map(snapshot.docs.map(item => [item.id, { id: item.id, ...item.data() }]));
        renderCount();
    }, error => console.error('Order status listener for payment badge failed:', error));
}


function setupNav() {
    const links = document.querySelectorAll('.nav-link');

    links.forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();

            links.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            const t = link.dataset.target;

            if (t === 'overview') {
                loadOverview();
            } else if (t === 'accounts' || t === 'customers') {
                loadAccounts('customers');
            } else if (t === 'verify-payments') {
                loadVerifyPayments();
            } else if (t === 'cancellation-requests') {
                loadCancellationRequests();
            } else if (t === 'products') {
                loadProducts();
            } else if (t === 'staff-driver') {
                loadAccounts('staff');
            } else if (t === 'delivery-assignments') {
                loadDeliveryAssignments();
            }
        });
    });
}

async function refreshPendingCustomerBadge() {
    const badge = document.getElementById('pending-customers-badge');
    if (!badge) return;
    try {
        const snap = await getDocs(collection(db, 'users'));
        let count = 0;
        snap.forEach(d => { const u = d.data(); if (u.role === 'customer' && (u.status || 'approved') === 'pending' && u.isActive !== false) count++; });
        badge.textContent = String(count);
        badge.style.display = count ? 'inline-flex' : 'none';
        const innerBadge=document.getElementById('accounts-pending-badge'); if(innerBadge){innerBadge.textContent=String(count);innerBadge.style.display=count?'inline-flex':'none';}
    } catch (e) { badge.textContent = '!'; }
}

function accountsTabs(active) {
    return `<div class="accounts-page-heading"><div><span class="customer-eyebrow">ACCOUNT MANAGEMENT</span><h2>Accounts</h2><p>Manage customer, staff, and driver accounts in one place.</p></div></div>
    <div class="accounts-tabs accounts-tabs-two" role="tablist" aria-label="Account types">
      <button type="button" role="tab" aria-selected="${active==='customers'}" class="accounts-tab ${active==='customers'?'active':''}" onclick="window.switchAccountsTab('customers')"><span class="accounts-tab-icon accounts-customer-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg></span><span>Customers</span><span class="badge badge-warning" id="accounts-pending-badge" style="display:none"></span></button>
      <button type="button" role="tab" aria-selected="${active==='team'}" class="accounts-tab ${active==='team'?'active':''}" onclick="window.switchAccountsTab('team')"><span class="accounts-tab-icon accounts-team-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg></span><span>Staff / Drivers</span></button>
    </div>`;
}
window.switchAccountsTab = tab => { window.__jtAccountsTab = tab; if(tab==='customers') loadCustomers(); else loadStaffDrivers(); };
function loadAccounts(tab='customers') { window.__jtAccountsTab = tab==='staff'||tab==='drivers'?'team':tab; if(window.__jtAccountsTab==='customers') loadCustomers(); else loadStaffDrivers(); }

async function loadCustomers() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
        ${accountsTabs('customers')}
        
        <div class="customer-modal-backdrop" id="create-customer-account-modal" hidden><section class="customer-details-modal create-team-modal" role="dialog" aria-modal="true" aria-labelledby="create-customer-title"><button class="customer-modal-close" id="close-customer-account-modal" aria-label="Close" type="button">×</button><h2 id="create-customer-title">Add Customer</h2><p>Create a customer account.</p><form id="create-customer-account-form"><div class="form-group"><label for="new-customer-name">Full Name</label><input id="new-customer-name" required></div><div class="form-group"><label for="new-customer-email">Email Address</label><input type="email" id="new-customer-email" required></div><div class="form-group"><label for="new-customer-phone">Phone Number</label><input type="tel" id="new-customer-phone" required></div><div class="form-group"><label for="new-customer-address">Delivery Address</label><textarea id="new-customer-address" maxlength="250" required placeholder="House no., street, barangay"></textarea></div><div class="form-group"><label for="new-customer-password">Temporary Password (minimum 6 characters)</label><input type="password" id="new-customer-password" minlength="6" required></div><button type="submit" class="btn-primary">Create Customer</button></form></section></div>
        <section class="customer-section customer-section-pending" style="margin-top:1rem">
            <h3>Pending Approval</h3>
            <div id="customer-requests-list">Loading customer requests...</div>
        </section>
        <div class="customer-toolbar customer-toolbar-responsive"><button type="button" class="btn-primary customer-add-button" id="add-customer-account-btn">+ Add Customer</button><label class="customer-search customer-search-responsive"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="customer-search-input" type="search" placeholder="Search name, email, phone, or address…" aria-label="Search customers"></label></div>
        <section class="customer-section customer-section-approved" style="margin-top:1rem">
            <div class="accounts-section-heading"><span class="badge badge-success" id="active-customer-count">0 Active</span></div>
            <div id="approved-customers-list">Loading customers...</div>
        </section>
        <details class="removed-customers-disclosure" style="margin-top:1rem">
            <summary class="removed-customers-summary">
                <span class="removed-customers-summary-title">Removed Customers</span>
                <span class="removed-customers-chevron" aria-hidden="true">⌄</span>
            </summary>
            <div class="removed-customers-content">
                <p>Customers removed from the active list. You can restore them if needed.</p>
                <div id="removed-customers-list">Loading removed customers...</div>
            </div>
        </details>`;
    const createCustomerModal = document.getElementById('create-customer-account-modal');
    document.getElementById('add-customer-account-btn')?.addEventListener('click', () => { createCustomerModal.hidden = false; });
    document.getElementById('close-customer-account-modal')?.addEventListener('click', () => { createCustomerModal.hidden = true; });
    createCustomerModal?.addEventListener('click', e => { if (e.target === createCustomerModal) createCustomerModal.hidden = true; });
    document.getElementById('create-customer-account-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const form = e.currentTarget;
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            await apiCreateUserAccount({ fullName: document.getElementById('new-customer-name').value.trim(), email: document.getElementById('new-customer-email').value.trim(), phoneNumber: document.getElementById('new-customer-phone').value.trim(), address: document.getElementById('new-customer-address').value.trim(), password: document.getElementById('new-customer-password').value, role: 'customer' });
            window.showToast('Customer account created successfully.', 'success');
            form.reset(); createCustomerModal.hidden = true; await loadCustomers();
        } catch (err) { window.showToast('Could not create customer: ' + err.message, 'error'); }
        finally { submit.disabled = false; }
    });
    const pendingTarget = document.getElementById('customer-requests-list');
    const approvedTarget = document.getElementById('approved-customers-list');
    const removedTarget = document.getElementById('removed-customers-list');
    try {
        const snap = await getDocs(collection(db, 'users'));
        const pending = [];
        const approved = [];
        const removed = [];
        snap.forEach(d => {
            const u = d.data();
            if (u.role !== 'customer') return;
            const item = { id: d.id, ...u };
            if ((u.status || 'approved') === 'pending' && u.isActive !== false) pending.push(item);
            else if ((u.status || 'approved') === 'approved' && u.isActive !== false) approved.push(item);
            else if (u.isActive === false && (u.removedAt || u.rejectedAt)) removed.push(item);
        });
        const newestFirst = (a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
        pending.sort(newestFirst);
        approved.sort((a,b) => String(a.fullName || a.email || '').localeCompare(String(b.fullName || b.email || '')));
        removed.sort((a,b) => (b.removedAt?.toMillis?.() || b.rejectedAt?.toMillis?.() || 0) - (a.removedAt?.toMillis?.() || a.rejectedAt?.toMillis?.() || 0));

        pendingTarget.innerHTML = renderCustomerList(pending, 'pending');
        approvedTarget.innerHTML = renderCustomerList(approved, 'approved');
        const activeCount = document.getElementById('active-customer-count'); if (activeCount) activeCount.textContent = `${approved.length} Active`;
        removedTarget.innerHTML = renderCustomerList(removed, 'removed');
        const searchInput = document.getElementById('customer-search-input');
        searchInput?.addEventListener('input', () => {
            const query = searchInput.value.trim().toLocaleLowerCase();
            document.querySelectorAll('.customer-row').forEach(row => {
                row.hidden = query !== '' && !row.textContent.toLocaleLowerCase().includes(query);
            });
            document.querySelectorAll('.customer-section').forEach(section => {
                const rows = [...section.querySelectorAll('.customer-row')];
                section.classList.toggle('customer-section-no-results', query !== '' && rows.length > 0 && rows.every(row => row.hidden));
            });
        });
        await refreshPendingCustomerBadge();
    } catch (e) {
        pendingTarget.innerHTML = `<p class="error-msg">Could not load customer requests: ${esc(e.message)}</p>`;
        approvedTarget.innerHTML = `<p class="error-msg">Could not load approved customers: ${esc(e.message)}</p>`;
        removedTarget.innerHTML = `<p class="error-msg">Could not load removed customers: ${esc(e.message)}</p>`;
    }
}


function renderCustomerList(items, kind) {
 if (!items.length) return `<p class="customer-empty">${({pending:'No pending customer requests.',approved:'No approved active customers yet.',removed:'No removed customers.'})[kind]}</p>`;
 return `<div class="customer-list">${items.map(u => {
  const address=u.address||u.deliveryAddress||'Not provided', id=esc(u.id);
  const date=kind==='pending'?(u.createdAt?.toDate?esc(u.createdAt.toDate().toLocaleString()):'Just now'):kind==='approved'?(u.approvedAt?.toDate?esc(u.approvedAt.toDate().toLocaleDateString()):'-'):(u.removedAt?.toDate?esc(u.removedAt.toDate().toLocaleDateString()):(u.rejectedAt?.toDate?esc(u.rejectedAt.toDate().toLocaleDateString()):'-'));
  let action='';
  if(kind==='pending') action=`<button class="btn-primary" onclick="window.approveCustomer('${id}')">Approve</button><button class="btn-secondary" onclick="window.rejectCustomer('${id}')">Reject</button>`;
  if(kind==='approved') action=`<button class="btn-secondary" onclick="window.deleteApprovedCustomer('${id}')">Remove</button>`;
  if(kind==='removed') action=`<button class="btn-primary" onclick="window.restoreCustomer('${id}')">Restore</button>`;
  return `<article class="customer-row customer-account-row"><div class="customer-main"><div class="customer-name-line"><span class="account-type-icon customer-type-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg></span><div class="customer-name">${esc(u.fullName||'-')}</div></div><button class="customer-address" type="button" aria-expanded="false" onclick="window.toggleCustomerAddress(this)">${esc(address)}</button><div class="customer-mobile-details"><div><b>Email</b><span>${esc(u.email||'-')}</span></div><div><b>Phone</b><span>${esc(u.phoneNumber||'-')}</span></div>${kind==='approved'?'':`<div><b>${kind==='pending'?'Registered':'Removed'}</b><span>${date}</span></div>`}</div></div><div class="customer-actions">${action}<button class="customer-more" type="button" title="View full details" aria-label="View full details" onclick="window.showCustomerActions('${id}','${kind}')">⋮</button></div></article>`;
 }).join('')}</div>`;
}
window.showCustomerActions = async (id, kind) => {
 const actions = kind==='pending'
  ? `<button type="button" class="btn-primary" data-action="approve">Approve customer</button><button type="button" class="btn-secondary customer-menu-danger" data-action="reject">Reject request</button>`
  : kind==='approved'
   ? `<button type="button" class="btn-secondary customer-menu-danger" data-action="remove">Remove customer</button>`
   : `<button type="button" class="btn-primary" data-action="restore">Restore customer</button>`;
 let modal=document.getElementById('customer-actions-modal');
 if(!modal){modal=document.createElement('div');modal.id='customer-actions-modal';modal.className='customer-modal-backdrop';modal.innerHTML=`<section class="customer-details-modal customer-actions-modal" role="dialog" aria-modal="true" aria-labelledby="customer-actions-title"><button class="customer-modal-close" type="button" aria-label="Close">×</button><h2 id="customer-actions-title">Customer actions</h2><div class="customer-actions-modal-buttons"></div></section>`;modal.querySelector('.customer-modal-close').onclick=()=>modal.remove();modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});document.body.appendChild(modal);}
 modal.querySelector('.customer-actions-modal-buttons').innerHTML=`<button type="button" class="btn-secondary" data-action="details">View full details</button>${actions}`;
 modal.querySelector('[data-action="details"]').onclick=()=>{modal.remove();window.showCustomerDetails(id,kind);};
 for(const action of ['approve','reject','remove','restore']){const button=modal.querySelector(`[data-action="${action}"]`);if(button)button.onclick=async()=>{modal.remove();if(action==='approve')await window.approveCustomer(id);if(action==='reject')await window.rejectCustomer(id);if(action==='remove')await window.deleteApprovedCustomer(id);if(action==='restore')await window.restoreCustomer(id);};}
};
window.toggleCustomerAddress = button => { const row=button.closest('.customer-row'); row.classList.toggle('customer-expanded'); button.setAttribute('aria-expanded',row.classList.contains('customer-expanded')?'true':'false'); };
window.showCustomerDetails = async (id, kind) => {
 try {
  const snap=await getDoc(doc(db,'users',id)); if(!snap.exists()) return window.showToast('Customer record not found.','error');
  const u=snap.data(), val=v=>esc(v||'-'), date=v=>v?.toDate?esc(v.toDate().toLocaleString()):'-';
  let modal=document.getElementById('customer-details-modal');
  if(!modal){ modal=document.createElement('div'); modal.id='customer-details-modal'; modal.className='customer-modal-backdrop'; modal.innerHTML=`<section class="customer-details-modal" role="dialog" aria-modal="true" aria-labelledby="customer-modal-title"><button class="customer-modal-close" aria-label="Close" type="button">×</button><h2 id="customer-modal-title">Customer Details</h2><div class="customer-modal-content"></div></section>`; modal.querySelector('.customer-modal-close').onclick=()=>modal.remove(); modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();}); document.body.appendChild(modal); }
  modal.querySelector('.customer-modal-content').innerHTML=`<div class="customer-profile-head"><span class="customer-avatar"><svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg></span><div><h3>${val(u.fullName)}</h3><span>${kind==='pending'?'Pending approval':kind==='approved'?'Approved customer':'Removed customer'}</span></div></div><dl class="customer-info-grid"><div><dt>Email</dt><dd>${val(u.email)}</dd></div><div><dt>Phone</dt><dd>${val(u.phoneNumber)}</dd></div><div class="customer-address-full"><dt>Full address</dt><dd>${val(u.address||u.deliveryAddress)}</dd></div><div><dt>Registered</dt><dd>${date(u.createdAt)}</dd></div><div><dt>Approved</dt><dd>${date(u.approvedAt)}</dd></div><div><dt>Account status</dt><dd>${val(u.status||'approved')}</dd></div></dl>`;
  modal.querySelector('.customer-modal-close').focus();
 } catch(e){window.showToast('Could not load customer details: '+e.message,'error');}
};

// A client-only app cannot safely delete another user's Firebase Authentication account.
// This removes the customer from the active list and blocks all customer access, while retaining
// the Firestore record for audit/history. Full Auth deletion needs a trusted server/Admin SDK.
window.deleteApprovedCustomer = async uid => {
    if (!await window.showConfirmModal({
        title: 'Remove approved customer?',
        message: 'Are you sure you want to remove this customer? They will no longer be able to log in or place orders. You can find them later under Removed Customers and restore them if needed.',
        confirmText: 'Remove customer',
        cancelText: 'Cancel',
        danger: true
    })) return;
    try {
        const ref = doc(db, 'users', uid);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== 'customer' || (snap.data().status || 'approved') !== 'approved') {
            throw new Error('This customer is no longer active. Refresh the list.');
        }
        await updateDoc(ref, {
            status: 'rejected',
            isActive: false,
            removedAt: serverTimestamp(),
            removedBy: auth.currentUser.uid
        });
        window.showToast('Customer removed from the active list and access blocked.', 'success');
        await loadCustomers();
    } catch (e) {
        window.showToast('Could not remove customer: ' + e.message, 'error');
    }
};


window.restoreCustomer = async uid => {
    if (!await window.showConfirmModal({
        title: 'Restore customer?',
        message: 'This customer will return to Approved Customers and will be able to log in and place orders again.',
        confirmText: 'Restore customer',
        cancelText: 'Cancel'
    })) return;
    try {
        const ref = doc(db, 'users', uid);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== 'customer' || snap.data().isActive !== false) {
            throw new Error('This customer cannot be restored. Refresh the list and try again.');
        }
        await updateDoc(ref, {
            status: 'approved',
            isActive: true,
            approvedAt: serverTimestamp(),
            approvedBy: auth.currentUser.uid,
            removedAt: deleteField(),
            removedBy: deleteField()
        });
        window.showToast('Customer restored successfully.', 'success');
        await loadCustomers();
    } catch (e) {
        window.showToast('Could not restore customer: ' + e.message, 'error');
    }
};

window.approveCustomer = async uid => {
    if (!await window.showConfirmModal({title:'Approve customer?', message:'This customer will be able to log in and place orders after approval.', confirmText:'Approve account', cancelText:'Cancel'})) return;
    try {
        const ref = doc(db, 'users', uid);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== 'customer' || snap.data().status !== 'pending') throw new Error('This request is no longer pending. Refresh the list.');
        await updateDoc(ref, {status:'approved', isActive:true, approvedAt:serverTimestamp(), approvedBy:auth.currentUser.uid});
        window.showToast('Customer approved successfully.', 'success');
        await loadCustomers();
    } catch(e) { window.showToast('Could not approve customer: '+e.message, 'error'); }
};

window.rejectCustomer = async uid => {
    if (!await window.showConfirmModal({title:'Reject customer request?', message:'The account will be marked rejected and blocked from the dashboard and customer actions. In this client-only setup, Firebase Authentication cannot safely delete another user account; permanent Auth deletion requires a trusted server/Admin SDK.', confirmText:'Reject and block', cancelText:'Cancel', danger:true})) return;
    try {
        const ref = doc(db, 'users', uid);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().role !== 'customer' || snap.data().status !== 'pending') throw new Error('This request is no longer pending. Refresh the list.');
        await updateDoc(ref, {status:'rejected', isActive:false, rejectedAt:serverTimestamp(), rejectedBy:auth.currentUser.uid});
        window.showToast('Request rejected and access blocked. Auth record retained for safety.', 'success');
        await loadCustomers();
    } catch(e) { window.showToast('Could not reject customer: '+e.message, 'error'); }
};


function listenForCancellationRequests() {
    if (window.__jtCancellationRequestsUnsubscribe) window.__jtCancellationRequestsUnsubscribe();
    window.__jtCancellationRequestsUnsubscribe = onSnapshot(collection(db, 'orders'), snapshot => {
        let count = 0; snapshot.forEach(d => { if (String(d.data().cancellationRequestStatus || '').toLowerCase() === 'pending') count++; });
        const badge = document.getElementById('pending-cancellations-badge');
        if (badge) { badge.textContent = String(count); badge.style.display = count ? 'inline-flex' : 'none'; }
        // Refresh the active queue even when the pending count drops to zero.
        // Otherwise an approved/rejected request can remain visible until manual refresh.
        if (document.querySelector('.nav-link.active')?.dataset.target === 'cancellation-requests') {
            loadCancellationRequests();
        }
    }, error => console.error('Cancellation request listener failed:', error));
}

// Small, centered JT-branded activity indicator for actions that need to wait for Firestore.
function showJTLoading(message = 'Updating…') {
    let overlay = document.getElementById('jt-global-loading');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'jt-global-loading';
        overlay.className = 'jt-global-loading-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        overlay.innerHTML = `<div class="jt-global-loading-card"><img src="${new URL('./assets/JT_LOGO.png', document.baseURI).href}" alt="" class="jt-global-loading-logo"><span class="jt-global-loading-message"></span><span class="jt-global-loading-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
        document.body.appendChild(overlay);
    }
    overlay.querySelector('.jt-global-loading-message').textContent = message;
    window.__jtGlobalLoadingCount = (window.__jtGlobalLoadingCount || 0) + 1;
    let hidden = false, revealed = false;
    const timer = window.setTimeout(() => {
        if (!hidden) { revealed = true; overlay.classList.add('is-visible'); }
    }, 160);
    return () => {
        if (hidden) return;
        hidden = true;
        window.clearTimeout(timer);
        window.__jtGlobalLoadingCount = Math.max(0, (window.__jtGlobalLoadingCount || 1) - 1);
        if (window.__jtGlobalLoadingCount === 0) overlay.classList.remove('is-visible');
    };
}

function renderCancellationRecords(ordersSnap) {
    const target = document.getElementById('gcash-cancellation-records');
    if (!target) return;
    const rows = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(o => ['approved', 'rejected'].includes(String(o.cancellationRequestStatus || '').toLowerCase()))
        .sort((a, b) => {
            const time = v => v?.toMillis ? v.toMillis() : v?.toDate ? v.toDate().getTime() : v ? new Date(v).getTime() : 0;
            return time(b.cancellationReviewedAt || b.updatedAt) - time(a.cancellationReviewedAt || a.updatedAt);
        });
    const input = document.getElementById('cancellation-records-search');
    const clear = document.getElementById('cancellation-records-search-clear');
    const draw = () => {
        const query = String(input?.value || '').trim().toLowerCase();
        const filtered = rows.filter(o => [
            o.id, o.customerName, o.customerId, o.cancellationRequestStatus, o.refundStatus
        ].some(value => String(value || '').toLowerCase().includes(query)));
        target.innerHTML = filtered.length ? `<table class="gcash-data-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Original Amount</th><th>Decision</th><th>Refund Status</th><th>Reviewed</th><th>Refund Proof</th></tr></thead><tbody>${filtered.map(o => {
            const date = o.cancellationReviewedAt?.toDate ? o.cancellationReviewedAt.toDate().toLocaleString('en-PH') : (o.cancellationReviewedAt || '-');
            const proof = o.refundProofImageData ? `<button type="button" class="btn-secondary" data-cancel-proof="${esc(o.id)}">View Proof</button>` : '—';
            return `<tr><td data-label="Order ID"><code>${esc(o.id)}</code></td><td data-label="Customer">${esc(String(o.customerName || o.customerId || '-'))}</td><td data-label="Original Amount" class="gcash-amount">₱${(Number(o.totalAmount) || 0).toFixed(2)}</td><td data-label="Decision">${esc(String(o.cancellationRequestStatus).toUpperCase())}</td><td data-label="Refund Status">${esc(String(o.refundStatus || 'Not recorded'))}</td><td data-label="Reviewed">${esc(String(date))}</td><td data-label="Refund Proof">${proof}</td></tr>`;
        }).join('')}</tbody></table>` : '<div class="gcash-empty"><strong>No matching cancellation records</strong><p>Try another order ID, customer name, or status.</p></div>';
        target.querySelectorAll('[data-cancel-proof]').forEach(button => button.addEventListener('click', () => {
            const order = filtered.find(o => o.id === button.dataset.cancelProof);
            if (!order?.refundProofImageData) return;
            const modal = document.createElement('div');
            modal.className = 'gcash-receipt-modal';
            modal.innerHTML = `<div class="gcash-receipt-modal-card" role="dialog" aria-modal="true"><header class="gcash-receipt-modal-header"><h2>Refund Proof — ${esc(order.id)}</h2><button type="button" class="gcash-modal-close" aria-label="Close">×</button></header><div class="gcash-receipt-preview-content"><img src="${order.refundProofImageData}" alt="Uploaded refund proof" style="display:block;max-width:100%;max-height:70vh;margin:auto;object-fit:contain"></div></div>`;
            document.body.appendChild(modal);
            modal.querySelector('.gcash-modal-close').onclick = () => modal.remove();
            modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
        }));
    };
    if (input && !input.dataset.bound) { input.dataset.bound = '1'; input.addEventListener('input', draw); }
    if (clear && !clear.dataset.bound) { clear.dataset.bound = '1'; clear.addEventListener('click', () => { if (input) input.value = ''; draw(); }); }
    draw();
}

async function loadCancellationRequests() {
    const hideLoading = showJTLoading('Refreshing…');
    const c = document.getElementById('app-content');
    c.innerHTML = `<section class="gcash-page"><header class="gcash-page-heading"><div><h2>Cancellation Request / Records</h2><p>Review requests and keep a searchable history of cancellation decisions.</p></div><button type="button" class="btn-secondary" id="cancel-requests-refresh">↻ Refresh</button></header><section class="gcash-panel"><div class="gcash-panel-heading"><div><h3>Requests Awaiting Review</h3><p>Review the request reason and order status before approving or rejecting.</p></div></div><div id="cancellation-requests-list" class="gcash-table-wrap">Loading requests…</div></section><section class="gcash-panel" id="gcash-cancellation-records-panel"><div class="gcash-panel-heading"><div><h3>Cancellation Records</h3><p>Previously reviewed requests and saved refund proof.</p></div></div><div class="cancellation-records-toolbar gcash-receipt-search-wrap"><label class="gcash-search gcash-search-top gcash-receipt-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="cancellation-records-search" type="search" placeholder="Search order ID, customer, or status..." aria-label="Search cancellation records"></label><button id="cancellation-records-search-clear" type="button" class="btn-secondary">Clear</button></div><div id="gcash-cancellation-records" class="gcash-table-wrap">Loading cancellation records…</div></section></section>`;
    document.getElementById('cancel-requests-refresh')?.addEventListener('click', loadCancellationRequests);
    const target = document.getElementById('cancellation-requests-list');
    try {
        const snap = await getDocs(collection(db, 'orders'));
        const pending = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => String(o.cancellationRequestStatus || '').toLowerCase() === 'pending');
        renderCancellationRecords(snap);
        const money = n => '₱' + (Number(n) || 0).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
        if (!pending.length) { target.innerHTML = '<div class="gcash-empty"><span aria-hidden="true">✓</span><strong>No pending cancellation requests</strong><p>New customer requests will appear here.</p></div>'; return; }
        target.innerHTML = `<table class="gcash-data-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Amount</th><th>Payment Status</th><th>Order Status</th><th>Reason</th><th>Requested</th><th>Actions</th></tr></thead><tbody>${pending.map(o => `<tr><td data-label="Order ID"><code>${esc(o.id.slice(0,10))}</code></td><td data-label="Customer">${esc(o.customerName || 'Customer')}</td><td data-label="Amount" class="gcash-amount">${money(o.totalAmount)}</td><td data-label="Payment Status">${esc(statusLabel(o.paymentStatus || 'unknown'))}</td><td data-label="Order Status">${esc(statusLabel(o.deliveryStatus || 'pending'))}</td><td data-label="Reason"><div class="jt-cancellation-reason">${esc(o.cancellationRequestReason || 'No reason provided')}</div></td><td data-label="Requested">${esc(o.cancellationRequestedAt?.toDate ? o.cancellationRequestedAt.toDate().toLocaleString('en-PH') : 'Recently')}</td><td data-label="Actions"><div class="gcash-row-actions"><button type="button" class="btn-primary" onclick="window.reviewCancellationRequest('${esc(o.id)}','open')">Review</button></div></td></tr>`).join('')}</tbody></table>`;
    } catch (e) { target.innerHTML = `<div class="gcash-empty"><strong>Could not load cancellation requests</strong><p>${esc(e.message || 'Please try again.')}</p></div>`; }
    finally { hideLoading(); }
}

window.reviewCancellationRequest = async (orderId, decision = 'open', options = {}) => {
    if (decision === 'open') {
        try {
            const snap = await getDoc(doc(db, 'orders', orderId));
            if (!snap.exists()) throw new Error('Order not found. Refresh the list.');
            const o = snap.data();
            if (String(o.cancellationRequestStatus || '').toLowerCase() !== 'pending') throw new Error('This request is no longer pending. Refresh the list.');
            const paidOnline = String(o.paymentStatus || '').toLowerCase() === 'paid' && ['online','gcash'].includes(String(o.paymentMethod || '').toLowerCase());
            document.getElementById('jt-cancellation-review-modal')?.remove();
            const modal = document.createElement('div');
            modal.id = 'jt-cancellation-review-modal';
            modal.className = 'customer-order-confirm-overlay jt-cancellation-review-overlay';
            modal.innerHTML = `<section class="customer-order-confirm-modal jt-cancellation-review-dialog" role="dialog" aria-modal="true" aria-labelledby="jt-cancel-review-title">
                <button type="button" class="customer-order-confirm-close" aria-label="Close review" data-close-review>×</button>
                <h2 id="jt-cancel-review-title">Review Cancellation Request</h2>
                <p class="customer-order-confirm-subtitle">Review the order and reason. For a paid GCash order, upload proof that the refund was returned before confirming cancellation.</p>
                <div class="jt-cancellation-detail-grid">
                  <div class="customer-order-confirm-meta"><span>Order ID</span><strong>${esc(orderId)}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Customer</span><strong>${esc(o.customerName || 'Customer')}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Order type</span><strong>${esc(o.type || 'Not specified')}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Order amount</span><strong>${'₱' + (Number(o.totalAmount)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Payment method</span><strong>${esc(o.paymentMethod || 'Not specified')}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Payment status</span><strong>${esc(statusLabel(o.paymentStatus || 'unknown'))}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Order status</span><strong>${esc(statusLabel(o.deliveryStatus || 'pending'))}</strong></div>
                  <div class="customer-order-confirm-meta"><span>Requested</span><strong>${esc(o.cancellationRequestedAt?.toDate ? o.cancellationRequestedAt.toDate().toLocaleString('en-PH') : 'Recently')}</strong></div>
                  <div class="jt-cancellation-detail-reason"><span>Customer's reason</span><p>${esc(o.cancellationRequestReason || 'No reason provided')}</p></div>
                </div>
                ${paidOnline ? `<div class="jt-refund-upload-group"><label class="customer-confirm-proof-label" for="jt-cancel-refund-proof">Refund proof screenshot <span>*</span></label><p class="customer-confirm-proof-status">Upload a screenshot showing that the GCash refund was actually returned to the customer. Cancellation cannot be approved without this proof.</p><input class="customer-confirm-proof-input" id="jt-cancel-refund-proof" type="file" accept="image/*" required><div id="jt-cancel-refund-preview" class="customer-confirm-proof-preview" hidden><img alt="Refund proof preview"><span>Refund screenshot ready</span></div></div>` : `<p class="customer-order-confirm-note jt-cancellation-note">Refund proof is not required because this order is not marked as a confirmed paid GCash order.</p>`}
                <div class="customer-order-confirm-actions jt-cancellation-review-actions"><button type="button" class="customer-order-confirm-back" data-close-review>Close</button><button type="button" class="jt-cancel-reject-btn" id="jt-cancel-reject">Reject request</button><button type="button" class="jt-cancel-approve-btn" id="jt-cancel-approve">Confirm cancellation</button></div>
              </section>`;
            document.body.appendChild(modal);
            const close = () => modal.remove();
            modal.querySelectorAll('[data-close-review]').forEach(b => b.addEventListener('click', close));
            modal.addEventListener('click', e => { if (e.target === modal) close(); });
            modal.querySelector('#jt-cancel-refund-proof')?.addEventListener('change', async e => {
                const file=e.target.files?.[0]; const preview=modal.querySelector('#jt-cancel-refund-preview');
                if (!file || !preview) return;
                try { const data=await window.jtPrepareImageData(file); preview.hidden=false; preview.querySelector('img').src=data; preview.querySelector('span').textContent='Refund screenshot ready'; }
                catch(err) { e.target.value=''; preview.hidden=true; window.showToast(err.message || 'Could not prepare refund screenshot.','error'); }
            });
            modal.querySelector('#jt-cancel-approve').addEventListener('click', async () => {
                const file=modal.querySelector('#jt-cancel-refund-proof')?.files?.[0] || null;
                await window.reviewCancellationRequest(orderId, 'approve', {modal, file});
            });
            modal.querySelector('#jt-cancel-reject').addEventListener('click', async () => {
                await window.reviewCancellationRequest(orderId, 'reject', {modal});
            });
        } catch (e) { window.showToast('Could not open cancellation request: ' + (e.message || 'Please try again.'), 'error'); }
        return;
    }
    if (!['approve','reject'].includes(decision)) return;
    const modal = options.modal || document.getElementById('jt-cancellation-review-modal');
    let hideActionLoading = null;
    try {
        const ref = doc(db, 'orders', orderId);
        const snap = await getDoc(ref);
        if (!snap.exists()) throw new Error('Order not found. Refresh and try again.');
        const order = snap.data();
        if (String(order.cancellationRequestStatus || '').toLowerCase() !== 'pending') throw new Error('This request has already been reviewed. Refresh the list.');
        const approve = decision === 'approve';
        if (approve && ['cancelled','completed','delivered','out_for_delivery'].includes(String(order.deliveryStatus || 'pending').toLowerCase())) throw new Error('This order has already been completed or dispatched and cannot be cancelled here.');
        const paidOnline = String(order.paymentStatus || '').toLowerCase() === 'paid' && ['online','gcash'].includes(String(order.paymentMethod || '').toLowerCase());
        let refundProof = '';
        if (approve && paidOnline) {
            const file = options.file || modal?.querySelector('#jt-cancel-refund-proof')?.files?.[0];
            if (!file) throw new Error('Upload the screenshot showing the GCash refund was returned before confirming cancellation.');
            refundProof = await window.jtPrepareImageData(file);
        }
        const confirm = await window.showConfirmModal({
            title: approve ? (paidOnline ? 'Confirm refund and cancellation' : 'Confirm cancellation') : 'Reject cancellation request?',
            message: approve ? (paidOnline ? 'Confirm that you have actually returned the GCash amount to the customer and that the attached screenshot proves the refund. This will cancel the order and close its payment-verification record.' : 'Cancel this order? No refund proof is required because the payment is not confirmed as paid through GCash.') : 'Reject this request? The order will remain active. If payment still needs verification, it can return to the normal payment-verification process.',
            confirmText: approve ? (paidOnline ? 'Refund returned & cancel' : 'Confirm cancellation') : 'Reject request',
            cancelText: 'Go back', danger: approve
        });
        if (!confirm) return;
        if (modal?.dataset.reviewSubmitting === 'true') return;
        hideActionLoading = showJTLoading(approve ? 'Approving…' : 'Rejecting…');
        if (modal) {
            modal.dataset.reviewSubmitting = 'true';
            modal.querySelectorAll('button').forEach(button => { button.disabled = true; });
        }
        // Queries cannot be read using Transaction.get() in the Firebase Web SDK.
        // Resolve linked payment references first, then transactionally re-read each document.
        const linkedSnap = await getDocs(query(collection(db, 'payments'), where('orderId', '==', orderId)));
        const paymentRefs = new Map();
        paymentRefs.set(orderId, doc(db, 'payments', orderId));
        linkedSnap.docs.forEach(paymentDoc => paymentRefs.set(paymentDoc.id, paymentDoc.ref));
        await runTransaction(db, async transaction => {
            const orderFresh = await transaction.get(ref);
            if (!orderFresh.exists()) throw new Error('Order not found. Refresh and try again.');
            const fresh = orderFresh.data();
            if (String(fresh.cancellationRequestStatus || '').toLowerCase() !== 'pending') throw new Error('This request has already been reviewed. Refresh the list.');
            if (approve && ['cancelled','completed','delivered','out_for_delivery'].includes(String(fresh.deliveryStatus || 'pending').toLowerCase())) throw new Error('This order has already been completed or dispatched and cannot be cancelled here.');
            const confirmedPaidOnline = String(fresh.paymentStatus || '').toLowerCase() === 'paid' && ['online','gcash'].includes(String(fresh.paymentMethod || '').toLowerCase());
            if (approve && confirmedPaidOnline && !refundProof) throw new Error('Refund proof is required for a confirmed paid GCash order.');
            const paymentSnapshots = [];
            for (const [id, paymentRef] of paymentRefs) {
                const paymentSnap = await transaction.get(paymentRef);
                if (paymentSnap.exists()) paymentSnapshots.push({id, ref:paymentRef, snap:paymentSnap});
            }
            // Build the order update from the transaction's fresh state so a concurrent
            // payment/status change cannot make the saved refund fields inconsistent.
            const fields = {
                cancellationRequestStatus: approve ? 'approved' : 'rejected',
                cancellationReviewedAt: serverTimestamp(),
                cancellationReviewedBy: auth.currentUser?.uid || '',
                updatedAt: serverTimestamp()
            };
            if (approve) {
                fields.deliveryStatus = 'cancelled';
                if (confirmedPaidOnline) {
                    fields.refundStatus = 'completed';
                    fields.refundProofImageData = refundProof;
                    fields.refundProofSubmittedAt = serverTimestamp();
                    fields.refundProofSubmittedBy = auth.currentUser?.uid || '';
                }
            }
            transaction.update(ref, fields);
            if (approve) paymentSnapshots.forEach(({snap:paymentSnap, ref:paymentRef}) => {
                const payment = paymentSnap.data();
                const status = String(payment.status || '').toLowerCase();
                const shouldClose = status === 'pending' || (confirmedPaidOnline && status === 'approved');
                if (!shouldClose) return;
                transaction.update(paymentRef, {
                    status: confirmedPaidOnline ? 'refunded' : 'cancelled', updatedAt: serverTimestamp(),
                    ...(confirmedPaidOnline ? {refundStatus:'completed', refundProofImageData:refundProof, refundCompletedAt:serverTimestamp(), refundCompletedBy:auth.currentUser?.uid || ''} : {cancellationReason:fresh.cancellationRequestReason || ''})
                });
            });
        });
        modal?.remove();
        window.showToast(approve ? (paidOnline ? 'Cancellation approved, refund recorded, and verification queue cleared.' : 'Cancellation approved and linked payment closed.') : 'Cancellation request rejected. The order remains active.', 'success');
        const hideRefreshLoading = showJTLoading('Updating…');
        try {
            await Promise.all([loadCancellationRequests(), loadVerifyPayments()]);
        } finally {
            hideRefreshLoading();
        }
    } catch (e) {
        if (modal) {
            delete modal.dataset.reviewSubmitting;
            modal.querySelectorAll('button').forEach(button => { button.disabled = false; });
        }
        window.showToast('Could not review cancellation request: ' + (e.message || 'Please try again.'), 'error');
    } finally {
        hideActionLoading?.();
    }
};

async function loadOverview(){
 const c=document.getElementById('app-content');
 c.innerHTML=`<section class="sales-overview-page">
   <div class="sales-summary-cards">
    <article class="sales-summary-card"><h3>Daily Sales</h3><label class="sr-only" for="sales-day-select">Select day</label><select id="sales-day-select"></select><strong id="sales-day-total">₱0.00</strong></article>
    <article class="sales-summary-card"><h3>Weekly Sales</h3><label class="sr-only" for="sales-week-select">Select week</label><select id="sales-week-select"></select><strong id="sales-week-total">₱0.00</strong></article>
    <article class="sales-summary-card"><h3>Monthly Sales</h3><label class="sr-only" for="sales-month-select">Select month</label><select id="sales-month-select"></select><strong id="sales-month-total">₱0.00</strong></article>
   </div>
   <section class="sales-chart-card">
    <div class="sales-chart-heading"><h2>Sales Overview</h2><div class="sales-chart-actions"><div class="sales-chart-filters" role="group" aria-label="Sales chart period"><button type="button" class="active" data-sales-period="daily">Daily</button><button type="button" data-sales-period="monthly">Monthly</button><button type="button" data-sales-period="yearly">Yearly</button></div><button type="button" class="gcash-print-pdf-button" id="sales-print-report" title="Preview, print, or save the sales report as PDF">Print / Save PDF</button></div></div>
    <div class="sales-chart-period-row"><button type="button" class="sales-chart-nav" id="sales-chart-prev" aria-label="Show older sales period" title="Older period"><span class="sales-chart-nav-glyph">‹</span></button><span id="sales-chart-period-label" aria-live="polite">Recent months</span><button type="button" class="sales-chart-nav" id="sales-chart-next" aria-label="Show newer sales period" title="Newer period" disabled><span class="sales-chart-nav-glyph">›</span></button></div>
    <div class="sales-chart-wrap"><canvas id="sales-overview-chart" aria-label="Sales overview bar chart" role="img"></canvas></div>
   </section>
   <p id="sales-overview-message" class="sales-overview-message" aria-live="polite"></p>
  </section>`;
 try{
  const [salesSnap,paymentsSnap]=await Promise.all([getDocs(collection(db,'sales')),getDocs(collection(db,'payments'))]);
  const sales=salesSnap.docs.map(d=>({id:d.id,...d.data()}));
  const pending=[...paymentsSnap.docs].filter(d=>{const p=d.data();return (p.method==='online'||String(p.method||'').toLowerCase().includes('gcash'))&&p.status==='pending';}).length;
  const dateOf=o=>{for(const k of ['createdAt','approvedAt','paidAt','date','timestamp','orderDate','created_at']){const v=o[k];if(v&&typeof v.toDate==='function')return v.toDate();if(v instanceof Date&&!isNaN(v))return v;if(typeof v==='number'){const d=new Date(v);if(!isNaN(d))return d;}if(typeof v==='string'){const d=new Date(v);if(!isNaN(d))return d;}}return null;};
  const amountOf=o=>Number(o.amount??o.total??o.totalAmount??o.paidAmount??0)||0;
  const dated=sales.map(o=>({...o,_date:dateOf(o),_amount:amountOf(o)}));
  const now=new Date(); let chartPeriod='monthly', chartOffset=0;
  const dayStart=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const weekStart=d=>{const x=dayStart(d);x.setDate(x.getDate()-((x.getDay()+6)%7));return x;};
  const sameDay=(a,b)=>a&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  const fmt=n=>'₱'+Number(n||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const daySelect=document.getElementById('sales-day-select'),weekSelect=document.getElementById('sales-week-select'),monthSelect=document.getElementById('sales-month-select');
  const days=[];for(let i=0;i<14;i++){const d=dayStart(now);d.setDate(d.getDate()-i);days.push(d);}daySelect.innerHTML=days.map((d,i)=>`<option value="${d.toISOString()}">${i===0?'Today':d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}</option>`).join('');
  const weeks=[];for(let i=0;i<12;i++){const d=weekStart(now);d.setDate(d.getDate()-7*i);weeks.push(d);}weekSelect.innerHTML=weeks.map((d,i)=>`<option value="${d.toISOString()}">${i===0?'This Week':`Week of ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`}</option>`).join('');
  const months=[];for(let i=0;i<12;i++){const d=new Date(now.getFullYear(),now.getMonth()-i,1);months.push(d);}monthSelect.innerHTML=months.map((d,i)=>`<option value="${d.toISOString()}">${i===0?'This Month':d.toLocaleDateString('en-US',{month:'long',year:'numeric'})}</option>`).join('');
  const inRange=(d,a,b)=>d&&d>=a&&d<b;
  const refreshTotals=()=>{
   const day=new Date(daySelect.value),ws=new Date(weekSelect.value),ms=new Date(monthSelect.value);const we=new Date(ws);we.setDate(we.getDate()+7);const me=new Date(ms.getFullYear(),ms.getMonth()+1,1);const de=new Date(day);de.setDate(de.getDate()+1);
   document.getElementById('sales-day-total').textContent=fmt(dated.filter(x=>inRange(x._date,dayStart(day),de)).reduce((a,x)=>a+x._amount,0));
   document.getElementById('sales-week-total').textContent=fmt(dated.filter(x=>inRange(x._date,ws,we)).reduce((a,x)=>a+x._amount,0));
   document.getElementById('sales-month-total').textContent=fmt(dated.filter(x=>inRange(x._date,ms,me)).reduce((a,x)=>a+x._amount,0));
  };
  const drawChart=()=>{
   const canvas=document.getElementById('sales-overview-chart');if(!canvas)return;const rect=canvas.getBoundingClientRect();const w=Math.max(260,rect.width||600),h=Math.max(210,rect.height||270),ratio=window.devicePixelRatio||1;canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
   let labels=[],values=[];const base=chartPeriod==='daily'?new Date(now.getFullYear(),now.getMonth(),now.getDate()):chartPeriod==='monthly'?new Date(now.getFullYear(),now.getMonth(),1):new Date(now.getFullYear(),0,1);
   if(chartPeriod==='daily'){for(let i=6;i>=0;i--){const d=new Date(base);d.setDate(d.getDate()-i+chartOffset*7);labels.push(d.toLocaleDateString('en-US',{weekday:'short'}));const end=new Date(d);end.setDate(end.getDate()+1);values.push(dated.filter(x=>inRange(x._date,d,end)).reduce((a,x)=>a+x._amount,0));}}
   else if(chartPeriod==='monthly'){for(let i=5;i>=0;i--){const d=new Date(base.getFullYear(),base.getMonth()-i+chartOffset*6,1);const e=new Date(d.getFullYear(),d.getMonth()+1,1);labels.push(d.toLocaleDateString('en-US',{month:'short'}));values.push(dated.filter(x=>inRange(x._date,d,e)).reduce((a,x)=>a+x._amount,0));}}
   else {for(let i=4;i>=0;i--){const y=base.getFullYear()-i+chartOffset*5;labels.push(String(y));values.push(dated.filter(x=>x._date&&x._date.getFullYear()===y).reduce((a,x)=>a+x._amount,0));}}
   const label=document.getElementById('sales-chart-period-label');if(label){label.textContent=chartPeriod==='daily'?'7-day view':chartPeriod==='monthly'?'6-month view':'5-year view';}const newer=document.getElementById('sales-chart-next');if(newer)newer.disabled=chartOffset>=0;const max=Math.max(1,...values),top=22,bottom=36,left=w<380?42:52,right=10,plotH=h-top-bottom,plotW=w-left-right;ctx.font=`${w<380?10:11}px Arial`;ctx.textAlign='right';ctx.textBaseline='middle';for(let i=0;i<=4;i++){const val=max*i/4,y=top+plotH-(plotH*i/4);ctx.strokeStyle='#e3e9eb';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();ctx.fillStyle='#61757d';ctx.fillText(val>=1000?(val/1000).toLocaleString('en-US',{maximumFractionDigits:1})+'k':Math.round(val).toString(),left-7,y);}
   const slot=plotW/labels.length,bw=Math.min(48,slot*.68);values.forEach((v,i)=>{const bh=plotH*v/max,x=left+slot*i+(slot-bw)/2,y=top+plotH-bh;ctx.fillStyle='#00b078';const r=Math.min(7,bw/2,bh/2);ctx.beginPath();ctx.moveTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.arcTo(x,y,x+bw,y,r);ctx.arcTo(x+bw,y,x+bw,y+r,r);ctx.lineTo(x+bw,top+plotH);ctx.lineTo(x,top+plotH);ctx.closePath();ctx.fill();ctx.fillStyle='#087f8c';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText(labels[i],x+bw/2,top+plotH+9);});
  };
  [daySelect,weekSelect,monthSelect].forEach(el=>el.addEventListener('change',refreshTotals));
  document.getElementById('sales-print-report')?.addEventListener('click',()=>{
   const existing=document.getElementById('sales-report-preview-modal');if(existing)existing.remove();
   const dateLabel=o=>o._date?o._date.toLocaleString('en-PH',{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'Date unavailable';
   const reportRows=[...dated].sort((a,b)=>(b._date?.getTime()||0)-(a._date?.getTime()||0)).map(o=>`<tr><td>${esc(String(o.orderId||o.id||'-'))}</td><td>${esc(String(o.paymentMethod||o.method||'—').toUpperCase())}</td><td>${esc(dateLabel(o))}</td><td class="amount">${fmt(o._amount)}</td></tr>`).join('');
   const selectedLabel=el=>el.options[el.selectedIndex]?.textContent||'—';
   const modal=document.createElement('div');modal.id='sales-report-preview-modal';modal.className='gcash-receipt-modal';
   modal.innerHTML=`<div class="gcash-receipt-modal-card sales-report-modal-card" role="dialog" aria-modal="true" aria-labelledby="sales-report-modal-title"><header class="gcash-receipt-modal-header"><div><h2 id="sales-report-modal-title">Sales Report Preview</h2><p>Review the report before printing or saving as PDF.</p></div><button type="button" class="gcash-modal-close" aria-label="Close preview">×</button></header><div class="gcash-receipt-preview-content sales-report-preview-content"><article class="sales-report-print-sheet"><div class="sales-report-brand"><img class="sales-report-logo" src="${new URL('./assets/JT_LOGO.png',document.baseURI).href}" alt="JT Water Refilling logo"><span>JT WATER REFILLING</span></div><h2>SALES REPORT</h2><p class="sales-report-subtitle">Sales Overview Summary and Transaction Records</p><p class="sales-report-generated">Generated ${esc(new Date().toLocaleString('en-PH'))}</p><section class="sales-report-summary"><div><strong>DAILY SALES</strong><small>${esc(selectedLabel(daySelect))}</small><b>${esc(document.getElementById('sales-day-total').textContent)}</b></div><div><strong>WEEKLY SALES</strong><small>${esc(selectedLabel(weekSelect))}</small><b>${esc(document.getElementById('sales-week-total').textContent)}</b></div><div><strong>MONTHLY SALES</strong><small>${esc(selectedLabel(monthSelect))}</small><b>${esc(document.getElementById('sales-month-total').textContent)}</b></div></section><h3>Recorded Sales (${dated.length})</h3><div class="sales-report-table-wrap"><table><thead><tr><th>Order / Sale ID</th><th>Payment Method</th><th>Date &amp; Time</th><th class="amount">Amount</th></tr></thead><tbody>${reportRows||'<tr><td colspan="4">No sales records available.</td></tr>'}</tbody></table></div><p class="sales-report-total">Total recorded sales: ${fmt(dated.reduce((sum,o)=>sum+o._amount,0))}</p><p class="sales-report-footer">JT Water Refilling System · End of Report</p></article></div><footer class="gcash-receipt-modal-actions"><button type="button" class="btn-secondary" data-save-sales-image="png">Save as PNG</button><button type="button" class="btn-secondary" data-save-sales-image="jpg">Save as JPG</button><button type="button" class="btn-primary" data-print-sales-report>Print / Save PDF</button></footer></div>`;
   document.body.appendChild(modal);const close=()=>modal.remove();modal.querySelector('.gcash-modal-close').onclick=close;modal.addEventListener('click',e=>{if(e.target===modal)close();});
   modal.querySelectorAll('[data-save-sales-image]').forEach(btn=>btn.onclick=()=>saveSalesReportImage(modal.querySelector('.sales-report-print-sheet'),btn.dataset.saveSalesImage));
   modal.querySelector('[data-print-sales-report]').onclick=async()=>{const w=window.open('','_blank');if(!w){window.showToast?.('Please allow pop-ups to print the sales report.','error');return;}const sheet=modal.querySelector('.sales-report-print-sheet').outerHTML;w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JT Water Refilling — Sales Report</title><style>body{font:14px Arial,sans-serif;color:#26383e;margin:24px}.sales-report-print-sheet{max-width:1000px;margin:auto}.sales-report-brand{display:flex;align-items:center;justify-content:center;gap:10px;max-width:max-content;margin:0 auto;color:#087f8c;font-weight:800;letter-spacing:1.5px;font-size:20px}.sales-report-logo{width:48px;height:48px;object-fit:contain;flex:0 0 auto}.sales-report-print-sheet h2{text-align:center}.sales-report-subtitle,.sales-report-generated,.sales-report-footer{text-align:center;color:#687980}.sales-report-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:24px 0}.sales-report-summary>div{border:1px solid #dce5e8;border-radius:10px;padding:14px;text-align:center}.sales-report-summary strong,.sales-report-summary small,.sales-report-summary b{display:block;margin-bottom:7px}.sales-report-summary strong{color:#087f8c}.sales-report-summary b{font-size:20px;color:#087f8c}table{width:100%;border-collapse:collapse}th{background:#e9f8f8;color:#087f8c;text-align:left}th,td{padding:10px 8px;border-bottom:1px solid #dce5e8;overflow-wrap:anywhere}.amount{text-align:right;white-space:nowrap;font-weight:bold}.sales-report-total{text-align:right;font-size:18px;font-weight:bold;border-top:2px solid #087f8c;padding-top:14px}@media(max-width:600px){body{margin:10px}.sales-report-summary{gap:5px}.sales-report-summary>div{padding:8px 4px}.sales-report-summary b{font-size:14px}th,td{padding:6px 4px;font-size:11px}}@media print{body{margin:0}.sales-report-summary{break-inside:avoid}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body>${sheet}<script>window.onload=async()=>{const imgs=[...document.images];await Promise.all(imgs.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;})));window.focus();window.print();}<\/script></body></html>`);w.document.close();};
  });
  document.querySelectorAll('[data-sales-period]').forEach(btn=>btn.addEventListener('click',()=>{chartPeriod=btn.dataset.salesPeriod;chartOffset=0;document.querySelectorAll('[data-sales-period]').forEach(b=>b.classList.toggle('active',b===btn));drawChart();}));
  document.getElementById('sales-chart-prev').addEventListener('click',()=>{chartOffset--;drawChart();});
  document.getElementById('sales-chart-next').addEventListener('click',()=>{if(chartOffset<0){chartOffset++;drawChart();}});
  refreshTotals();drawChart();window.addEventListener('resize',drawChart,{passive:true});
  if(!dated.some(x=>x._date))document.getElementById('sales-overview-message').textContent='Sales are shown when records include a valid date and amount. Records without dates are not included in period totals or chart.';
 }catch(e){c.insertAdjacentHTML('beforeend',`<p class="error-msg">${esc(e.message)}</p>`);}
}
function displayPaymentMethod(value){
  const method=String(value||'').trim().toLowerCase();
  if(!method)return '';
  if(method==='gcash'||method==='online'||method==='e-wallet'||method==='ewallet')return method==='gcash'?'GCash':'Online Payment';
  if(method==='cod'||method==='cash on delivery'||method==='cash-on-delivery')return 'Cash on Delivery';
  if(method==='cash')return 'Cash';
  return method.split(/[_-]+/).map(part=>part?part.charAt(0).toUpperCase()+part.slice(1):'').join(' ');
}
async function loadVerifyPayments(){
 const hideLoading = showJTLoading('Refreshing payment records…');
 const c=document.getElementById('app-content');
 c.innerHTML=`<section class="gcash-page">
   <header class="gcash-page-heading"><div><h2>GCash Payment Verification</h2><p>Open each payment screenshot, compare it with the actual GCash transaction, then approve or reject.</p></div><div style="display:flex;gap:8px;align-items:center"><button type="button" class="btn-secondary" id="gcash-refresh">↻ Refresh</button><button type="button" class="gcash-settings-gear" id="open-gcash-settings" aria-label="Open GCash Payment Settings" title="GCash Payment Settings"><svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M19.14 12.94a7.49 7.49 0 0 0 .05-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.95l-.36-2.54A.49.49 0 0 0 13.95 2h-3.9a.49.49 0 0 0-.49.42L9.2 4.96a7.3 7.3 0 0 0-1.63.95l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.49a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.95l.36 2.54a.49.49 0 0 0 .49.42h3.9a.49.49 0 0 0 .49-.42l.36-2.54c.58-.24 1.13-.56 1.63-.95l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg></button></div></header>
   <section class="gcash-panel"><div class="gcash-panel-heading"><div><h3>Payments Awaiting Verification <span class="badge badge-warning gcash-pending-count" id="gcash-pending-count" style="display:none">0</span></h3><p>Review the uploaded screenshot and confirm the amount against the actual GCash transaction.</p></div></div><div id="payments-list" class="gcash-table-wrap">Loading payments...</div></section>
   <section class="gcash-panel gcash-receipts-panel"><div class="gcash-panel-heading"><div><h3>Recent Official Receipts</h3><p>Approved payments and their complete receipt details.</p></div><button type="button" class="gcash-print-pdf-button" id="gcash-receipts-print" aria-label="Preview and print all official receipts" title="Preview and print all official receipts">Print / Save PDF</button></div><label class="gcash-search gcash-search-top gcash-receipt-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="gcash-receipt-search" type="search" placeholder="Search customer, receipt, order, or date..." aria-label="Search official receipts"></label><p class="gcash-receipt-search-hint" id="gcash-receipt-search-hint">Date search examples: <strong>2026-10-22</strong>, <strong>10/22/2026</strong>, or <strong>Oct 22, 2026</strong>.</p><div id="recent-receipts" class="gcash-table-wrap">Loading receipts...</div></section>
 </section>`;
 document.getElementById("open-gcash-settings")?.addEventListener("click", openGcashSettingsModal);
 document.getElementById("gcash-refresh")?.addEventListener("click", async e => { const b=e.currentTarget; if(b.disabled)return; b.disabled=true; b.textContent="Refreshing…"; try { await loadVerifyPayments(); } finally { /* the page is re-rendered; button lifecycle ends here */ } });
 const target=document.getElementById('payments-list');
 try{
  const [snap,receipts,ordersSnap,salesSnap]=await Promise.all([getDocs(collection(db,'payments')),getDocs(collection(db,'receipts')),getDocs(collection(db,'orders')),getDocs(collection(db,'sales'))]);
  const orderById=new Map();ordersSnap.forEach(d=>orderById.set(d.id,d.data()));
  const saleByOrderId=new Map();salesSnap.forEach(d=>{const sale=d.data();const orderId=sale.orderId||sale.orderID;if(orderId)saleByOrderId.set(orderId,sale);});
  const newestFirstReceipts=receipts.docs.slice().sort((a,b)=>{
   const dateOf=d=>{const value=d.data().createdAt||d.data().date;return value?.toDate?value.toDate().getTime():new Date(value||0).getTime()||0;};
   return dateOf(b)-dateOf(a);
  });
  const displayPaymentMethod=value=>{const method=String(value||'').toLowerCase();if(method==='cod'||method==='cash')return 'COD';if(method==='online'||method==='gcash')return 'GCash';return '';};
  let pendingCount=0,pendingAmount=0;
  window.__jtPaymentProofs = {};
  let rows='<table class="gcash-data-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Amount</th><th>Payment Proof</th><th>Submitted</th><th>Status</th><th>Actions</th></tr></thead><tbody>',found=false;
  const pendingByOrder = new Map();
  const paymentTime = p => p?.updatedAt?.toMillis ? p.updatedAt.toMillis() : p?.updatedAt?.toDate ? p.updatedAt.toDate().getTime() : 0;
  snap.forEach(d=>{const p=d.data();if(String(p.method||'').toLowerCase()!=='online'||String(p.status||'').toLowerCase()!=='pending')return;const orderId=String(p.orderId||d.id);const linkedOrder=orderById.get(orderId)||orderById.get(d.id)||{};if(String(linkedOrder.cancellationRequestStatus||'').toLowerCase()==='pending'||String(linkedOrder.deliveryStatus||'').toLowerCase()==='cancelled'||String(linkedOrder.refundStatus||'').toLowerCase()==='completed')return;const candidate={id:d.id,p,orderId};const current=pendingByOrder.get(orderId);if(!current||(!current.p.proofImageData&&p.proofImageData)||(Boolean(current.p.proofImageData)===Boolean(p.proofImageData)&&paymentTime(p)>paymentTime(current.p)))pendingByOrder.set(orderId,candidate);});
  pendingByOrder.forEach(({id:dId,p,orderId})=>{found=true;pendingCount++;pendingAmount+=Number(p.amount)||0;if(p.proofImageData)window.__jtPaymentProofs[dId]=p.proofImageData;rows+=`<tr><td data-label="Order ID"><code>${esc(String(orderId).slice(0,8))}</code></td><td data-label="Customer">${esc(p.customerName||'Customer')}<small class="gcash-subdetail"><code>${esc(String(p.customerId||'').slice(0,8))}</code></small></td><td data-label="Amount" class="gcash-amount">₱${(Number(p.amount)||0).toFixed(2)}</td><td data-label="Payment Proof">${p.proofImageData?`<button type="button" class="gcash-view-proof-btn" onclick="window.viewPaymentProof('${esc(dId)}')"><img src="${esc(p.proofImageData)}" alt="Payment proof thumbnail"><span>View proof</span></button>`:'<span class="gcash-proof-missing">No screenshot uploaded</span>'}</td><td data-label="Submitted">${esc(p.updatedAt?.toDate?p.updatedAt.toDate().toLocaleString('en-PH'):'Just now')}</td><td data-label="Status"><span class="gcash-status gcash-status-pending">Pending</span></td><td data-label="Actions"><div class="gcash-row-actions"><button class="btn-primary gcash-approve-btn" onclick="window.approvePayment('${esc(dId)}','${esc(orderId)}')">Approve</button><button class="btn-secondary gcash-reject-btn" onclick="window.rejectPayment('${esc(dId)}','${esc(orderId)}')">Reject</button></div></td></tr>`;});
  const pendingBadge=document.getElementById('gcash-pending-count');if(pendingBadge){pendingBadge.textContent=String(pendingCount);pendingBadge.style.display=pendingCount?'inline-flex':'none';}
  rows+='</tbody></table>';target.innerHTML=found?rows:'<div class="gcash-empty"><span aria-hidden="true">✓</span><strong>No pending GCash payments</strong><p>There are no payments waiting for verification right now. Orders with pending cancellation requests are held for review in Cancellation Requests.</p></div>';

  const receiptData=[];
  let receiptRows='<table class="gcash-table"><thead><tr><th>Customer</th><th>Payment Method</th><th>Amount</th><th>Receipt No.</th><th>Order ID</th><th>Date &amp; Time</th><th>Details</th></tr></thead><tbody>';
  const cancellationReceiptRows=ordersSnap.docs.map(d=>({id:d.id,...d.data()})).filter(o=>String(o.cancellationRequestStatus||'').toLowerCase()==='approved').map(o=>({id:'cancel-'+o.id,receiptNumber:o.cancellationReceiptNumber||('CR-'+String(o.id).slice(-8).toUpperCase()),orderId:o.id,customerName:o.customerName||o.customerId||'-',customerId:o.customerId||'-',paymentMethod:'GCash Refund',totalAmount:Number(o.totalAmount)||0,dateTime:o.cancellationReviewedAt?.toDate?o.cancellationReviewedAt.toDate().toLocaleString():(o.cancellationReviewedAt||'-'),dateSearch:String(o.cancellationReviewedAt?.toDate?o.cancellationReviewedAt.toDate().toISOString().slice(0,10):o.cancellationReviewedAt||''),status:'Cancellation Approved · Refund '+String(o.refundStatus||'recorded'),items:[],type:'cancellation',raw:o}));
  newestFirstReceipts.forEach(d=>{const r=d.data();const orderId=r.orderId||d.id;const linkedOrder=orderById.get(orderId)||{};const linkedSale=saleByOrderId.get(orderId)||{};const rawDate=r.createdAt?.toDate?r.createdAt.toDate():(r.createdAt instanceof Date?r.createdAt:(r.createdAt||r.date?new Date(r.createdAt||r.date):null));const created=rawDate&&!Number.isNaN(rawDate.getTime())?rawDate.toLocaleString():(r.createdAt||r.date||'-');const dateSearch=rawDate&&!Number.isNaN(rawDate.getTime())?[rawDate.toISOString().slice(0,10),rawDate.toLocaleDateString('en-US'),rawDate.toLocaleDateString('en-GB'),rawDate.toLocaleDateString('en-PH'),rawDate.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),rawDate.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}),String(rawDate.getFullYear()),String(rawDate.getMonth()+1).padStart(2,'0')+'/'+String(rawDate.getDate()).padStart(2,'0')+'/'+rawDate.getFullYear()].join(' '):String(r.createdAt||r.date||'');const method=displayPaymentMethod(r.paymentMethod||r.method)||displayPaymentMethod(linkedSale.paymentMethod)||displayPaymentMethod(linkedOrder.paymentMethod);const details=r.customerDetails||{};const item={id:d.id,receiptNumber:r.receiptNumber||'-',orderId,customerName:r.customerName||r.customer||details.name||linkedOrder.customerName||r.customerId||'-',customerId:r.customerId||details.uid||linkedOrder.customerId||'-',paymentMethod:method||'Unknown',totalAmount:Number(r.totalAmount??r.amount??linkedSale.amount??linkedOrder.totalAmount)||0,dateTime:created,dateSearch,status:r.status||'Approved',items:Array.isArray(r.items)?r.items:(Array.isArray(linkedOrder.items)?linkedOrder.items:[]),raw:r};receiptData.push(item);receiptRows+=`<tr data-date-search="${esc(dateSearch)}"><td data-label="Customer">${esc(String(item.customerName))}<small class="gcash-subdetail">${esc(String(item.customerId))}</small></td><td data-label="Payment Method">${esc(String(item.paymentMethod))}</td><td data-label="Amount" class="gcash-amount">₱${item.totalAmount.toFixed(2)}</td><td data-label="Receipt No."><strong>${esc(item.receiptNumber)}</strong></td><td data-label="Order ID"><code>${esc(String(item.orderId))}</code></td><td data-label="Date & Time">${esc(String(item.dateTime))}</td><td data-label="Details"><button type="button" class="btn-secondary gcash-receipt-detail-btn" data-receipt-id="${esc(item.id)}">View</button></td></tr>`;});
  cancellationReceiptRows.forEach(item=>{receiptData.push(item);receiptRows+=`<tr data-date-search="${esc(item.dateSearch)}"><td data-label="Customer">${esc(String(item.customerName))}<small class="gcash-subdetail">Cancellation record</small></td><td data-label="Payment Method">${esc(String(item.paymentMethod))}</td><td data-label="Amount" class="gcash-amount">₱${item.totalAmount.toFixed(2)}</td><td data-label="Receipt No."><strong>${esc(item.receiptNumber)}</strong></td><td data-label="Order ID"><code>${esc(String(item.orderId))}</code></td><td data-label="Date & Time">${esc(String(item.dateTime))}</td><td data-label="Details"><button type="button" class="btn-secondary gcash-receipt-detail-btn" data-receipt-id="${esc(item.id)}">View</button></td></tr>`;});
  receiptRows+='</tbody></table>';
  const receiptTarget=document.getElementById('recent-receipts');
  receiptTarget.innerHTML=receipts.empty?'<div class="gcash-empty"><span aria-hidden="true">✓</span><strong>No official receipts yet</strong><p>Receipts will appear here after payments are approved.</p></div>':receiptRows;
  const receiptSearch=document.getElementById('gcash-receipt-search');
  const receiptDateHint=document.getElementById('gcash-receipt-search-hint');
  if(receiptDateHint){
    const now=new Date();
    const iso=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const us=`${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
    const long=now.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    receiptDateHint.innerHTML=`Date search examples: <strong>${iso}</strong>, <strong>${us}</strong>, or <strong>${esc(long)}</strong>.`;
  }
  if(receiptSearch) receiptSearch.addEventListener('input',()=>{
    const q=receiptSearch.value.trim().toLowerCase();
    receiptTarget.querySelectorAll('tbody tr').forEach(row=>{const searchable=`${row.textContent} ${row.dataset.dateSearch||''}`.toLowerCase();row.hidden=!searchable.includes(q);});
  });
  receiptTarget.querySelectorAll('[data-receipt-id]').forEach(btn=>btn.addEventListener('click',()=>openReceiptPreview(receiptData.filter(r=>r.id===btn.dataset.receiptId))));
  const printAll=document.getElementById('gcash-receipts-print');if(printAll)printAll.onclick=()=>openReceiptPreview(receiptData);
 }catch(e){target.innerHTML=`<p class="error-msg">${esc(e.message)}</p>`;const receiptTarget=document.getElementById('recent-receipts');if(receiptTarget)receiptTarget.innerHTML=`<p class="error-msg">${esc(e.message)}</p>`;} finally { hideLoading(); }
}
function openReceiptPreview(receipts){
 const existing=document.getElementById('gcash-receipt-preview-modal');if(existing)existing.remove();
 const money=n=>'₱'+(Number(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const rows=receipts.map((r,i)=>`<article class="gcash-print-receipt"><div class="gcash-print-brand">JT WATER REFILLING</div><h3>${r.type==='cancellation'?'CANCELLATION & REFUND RECORD':'OFFICIAL RECEIPT'}</h3><div class="gcash-print-receipt-no">${esc(r.receiptNumber||'-')}</div><div class="gcash-print-rule"></div><dl><dt>Order ID</dt><dd>${esc(String(r.orderId||'-'))}</dd><dt>Customer</dt><dd>${esc(String(r.customerName||'-'))}</dd><dt>Customer ID</dt><dd>${esc(String(r.customerId||'-'))}</dd><dt>Payment Method</dt><dd>${esc(String(r.paymentMethod||'Unknown'))}</dd>${r.type==='cancellation'?`<dt>Record Type</dt><dd>Cancellation & Refund</dd><dt>Refund Status</dt><dd>${esc(String(r.raw?.refundStatus||'Recorded'))}</dd><dt>Original Receipt</dt><dd>See original receipt for this order</dd>`:''}<dt>Date & Time</dt><dd>${esc(String(r.dateTime||'-'))}</dd><dt>Status</dt><dd>${esc(String(r.status||'Approved'))}</dd></dl><div class="gcash-print-total"><span>${r.type==='cancellation'?'REFUND AMOUNT RECORDED':'TOTAL PAID'}</span><strong>${money(r.totalAmount)}</strong></div>${r.items?.length?`<h4>Items</h4><ul>${r.items.map(it=>`<li>${esc(String(it.name||it.productName||'Item'))} — ${esc(String(it.quantity||1))} × ${money(it.price||it.unitPrice||0)}</li>`).join('')}</ul>`:''}<p class="gcash-print-thanks">Thank you for your purchase.</p></article>`).join('');
 const modal=document.createElement('div');modal.id='gcash-receipt-preview-modal';modal.className='gcash-receipt-modal';modal.innerHTML=`<div class="gcash-receipt-modal-card" role="dialog" aria-modal="true" aria-labelledby="gcash-receipt-modal-title"><header class="gcash-receipt-modal-header"><div><h2 id="gcash-receipt-modal-title">Official Receipts Preview</h2><p>${receipts.length} receipt${receipts.length===1?'':'s'} · Review before printing or saving.</p></div><button type="button" class="gcash-modal-close" aria-label="Close preview">×</button></header><div class="gcash-receipt-preview-content">${receipts.length?rows:'<div class="gcash-empty"><strong>No receipts to preview</strong></div>'}</div><footer class="gcash-receipt-modal-actions"><button type="button" class="btn-secondary" data-save-image="png">Save as PNG</button><button type="button" class="btn-secondary" data-save-image="jpg">Save as JPG</button><button type="button" class="btn-primary" data-print-receipts>Print / Save PDF</button></footer></div>`;
 document.body.appendChild(modal);const close=()=>modal.remove();modal.querySelector('.gcash-modal-close').onclick=close;modal.addEventListener('click',e=>{if(e.target===modal)close();});
 modal.querySelector('[data-print-receipts]').onclick=()=>{const w=window.open('','_blank');if(!w){window.showToast?.('Please allow pop-ups to print receipts.','error');return;}w.document.write(`<!doctype html><html><head><title>Official Receipts</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px Arial,sans-serif;color:#26383e;margin:20px}.receipt{max-width:680px;margin:0 auto 24px;padding:24px;border:1px solid #dce5e8;page-break-after:always}.brand{text-align:center;color:#087f8c;font-weight:bold;letter-spacing:1px}.receipt h3{text-align:center;margin:8px 0}.no{text-align:center;color:#687980}.rule{border-top:1px dashed #9aabad;margin:16px 0}dl{display:grid;grid-template-columns:140px 1fr;gap:9px}dt{color:#687980}dd{margin:0;overflow-wrap:anywhere}.total{display:flex;justify-content:space-between;border-top:1px solid #dce5e8;padding-top:14px;margin-top:18px;font-weight:bold;font-size:18px}.thanks{text-align:center;margin-top:22px;color:#687980}@media print{body{margin:0}.receipt{border:0;padding:18mm;page-break-after:always}}</style></head><body>${receipts.map(r=>`<section class="receipt"><div class="brand">JT WATER REFILLING</div><h3>OFFICIAL RECEIPT</h3><div class="no">${esc(r.receiptNumber||'-')}</div><div class="rule"></div><dl><dt>Order ID</dt><dd>${esc(String(r.orderId||'-'))}</dd><dt>Customer</dt><dd>${esc(String(r.customerName||'-'))}</dd><dt>Customer ID</dt><dd>${esc(String(r.customerId||'-'))}</dd><dt>Payment Method</dt><dd>${esc(String(r.paymentMethod||'Unknown'))}</dd><dt>Date & Time</dt><dd>${esc(String(r.dateTime||'-'))}</dd><dt>Status</dt><dd>${esc(String(r.status||'Approved'))}</dd></dl><div class="total"><span>TOTAL PAID</span><span>${money(r.totalAmount)}</span></div><p class="thanks">Thank you for your purchase.</p></section>`).join('')}<script>window.onload=()=>window.print()<\/script></body></html>`);w.document.close();};
 modal.querySelectorAll('[data-save-image]').forEach(btn=>btn.onclick=()=>saveReceiptImage(receipts,btn.dataset.saveImage));
}
function saveSalesReportImage(sheet,format){
 try{
  const width=1200,pad=42,scale=2,inner=width-pad*2;
  const rows=[...sheet.querySelectorAll('tbody tr')].map(tr=>[...tr.cells].map(td=>td.textContent.trim()));
  const summary=[...sheet.querySelectorAll('.sales-report-summary>div')].map(el=>({title:el.querySelector('strong')?.textContent||'',label:el.querySelector('small')?.textContent||'',amount:el.querySelector('b')?.textContent||''}));
  const title=sheet.querySelector('h2')?.textContent||'SALES REPORT';
  const generated=sheet.querySelector('.sales-report-generated')?.textContent||'';
  const total=sheet.querySelector('.sales-report-total')?.textContent||'';
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('Canvas export is not supported by this browser.');
  const rowHeight=42,summaryHeight=100,tableTop=350;
  const height=Math.max(620,tableTop+Math.max(1,rows.length)*rowHeight+130);
  canvas.width=width*scale;canvas.height=height*scale;ctx.scale(scale,scale);
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);
  const drawReport=()=>{
   // Official JT logo is drawn into the export itself, so it appears in PNG, JPG and PDF/print output.
   const logo=document.createElement('img');
   const drawHeader=()=>{
    ctx.fillStyle='#087f8c';ctx.textAlign='center';ctx.font='bold 22px Arial';
    const brandText='JT WATER REFILLING', logoSize=48, brandGap=12, brandTextWidth=ctx.measureText(brandText).width;
    const brandStart=(width-(logoSize+brandGap+brandTextWidth))/2;
    try{if(logo.complete&&logo.naturalWidth){const ratio=Math.min(logoSize/logo.naturalWidth,logoSize/logo.naturalHeight);const lw=logo.naturalWidth*ratio,lh=logo.naturalHeight*ratio;ctx.drawImage(logo,brandStart,12,lw,lh);ctx.textAlign='left';ctx.fillText(brandText,brandStart+logoSize+brandGap,42);}else{ctx.textAlign='center';ctx.fillText(brandText,width/2,42);}}catch(e){ctx.textAlign='center';ctx.fillText(brandText,width/2,42);}
    ctx.fillStyle='#26383e';ctx.textAlign='center';ctx.font='bold 26px Arial';ctx.fillText(title,width/2,82);
    ctx.fillStyle='#687980';ctx.font='14px Arial';ctx.fillText('Sales Overview Summary and Transaction Records',width/2,108);ctx.fillText(generated,width/2,132);
    const gap=14,cardW=(inner-gap*2)/3,cardY=158;
    summary.forEach((item,i)=>{const x=pad+i*(cardW+gap);ctx.fillStyle='#f6fbfc';ctx.strokeStyle='#dce5e8';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(x,cardY,cardW,summaryHeight,10);ctx.fill();ctx.stroke();ctx.textAlign='center';ctx.fillStyle='#087f8c';ctx.font='bold 15px Arial';ctx.fillText(item.title,x+cardW/2,cardY+25);ctx.fillStyle='#687980';ctx.font='13px Arial';ctx.fillText(item.label,x+cardW/2,cardY+47);ctx.fillStyle='#087f8c';ctx.font='bold 22px Arial';ctx.fillText(item.amount,x+cardW/2,cardY+78);});
    ctx.textAlign='left';ctx.fillStyle='#26383e';ctx.font='bold 18px Arial';ctx.fillText('Recorded Sales ('+rows.length+')',pad,292);
    const cols=[inner*.28,inner*.23,inner*.30,inner*.19],headers=['Order / Sale ID','Payment Method','Date & Time','Amount'];let x=pad;
    ctx.fillStyle='#e9f8f8';ctx.fillRect(pad,tableTop,inner,38);
    headers.forEach((h,i)=>{ctx.fillStyle='#087f8c';ctx.font='bold 13px Arial';ctx.textAlign=i===3?'right':'left';ctx.fillText(h,i===3?x+cols[i]-8:x+8,tableTop+24);x+=cols[i];});
    rows.forEach((r,ri)=>{const y=tableTop+38+ri*rowHeight;ctx.fillStyle=ri%2?'#ffffff':'#f8fbfc';ctx.fillRect(pad,y,inner,rowHeight);ctx.strokeStyle='#e3eaec';ctx.beginPath();ctx.moveTo(pad,y+rowHeight);ctx.lineTo(pad+inner,y+rowHeight);ctx.stroke();let xx=pad;r.forEach((value,i)=>{ctx.fillStyle='#26383e';ctx.font=i===3?'bold 13px Arial':'13px Arial';ctx.textAlign=i===3?'right':'left';let text=String(value||'—');const maxW=cols[i]-16;while(text.length>3&&ctx.measureText(text).width>maxW)text=text.slice(0,-2)+'…';ctx.fillText(text,i===3?xx+cols[i]-8:xx+8,y+25);xx+=cols[i];});});
    const footerY=tableTop+38+rows.length*rowHeight+32;ctx.strokeStyle='#087f8c';ctx.beginPath();ctx.moveTo(pad,footerY-14);ctx.lineTo(pad+inner,footerY-14);ctx.stroke();ctx.textAlign='right';ctx.fillStyle='#26383e';ctx.font='bold 18px Arial';ctx.fillText(total,pad+inner,footerY+12);ctx.textAlign='center';ctx.fillStyle='#687980';ctx.font='12px Arial';ctx.fillText('JT Water Refilling System · End of Report',width/2,height-22);
    const mime=format==='jpg'?'image/jpeg':'image/png';
    canvas.toBlob(blob=>{if(!blob){window.showToast?.('Could not create the image file. Please try again.','error');return;}const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='jt-sales-report.'+(format==='jpg'?'jpg':'png');document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);},mime,0.94);
   };
   logo.onload=()=>{drawHeader();};
   logo.onerror=()=>{console.warn('JT logo asset could not be loaded; exporting report without the image logo.');drawHeader();};
   logo.src=new URL('./assets/JT_LOGO.png',document.baseURI).href;
  };
  drawReport();
 }catch(err){console.error('Sales report image export failed:',err);window.showToast?.('Unable to save the report image. Try again or use Print / Save PDF.','error');}
}
function saveReceiptImage(receipts,format){
 const scale=2,width=1000,pad=58,rowH=42,receiptH=430;const height=Math.max(320,pad*2+receipts.length*(receiptH+30));const canvas=document.createElement('canvas');canvas.width=width*scale;canvas.height=height*scale;const ctx=canvas.getContext('2d');ctx.scale(scale,scale);ctx.fillStyle='#f3f7f8';ctx.fillRect(0,0,width,height);const money=n=>'₱'+(Number(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});let y=pad;
 ctx.textBaseline='top';receipts.forEach(r=>{ctx.fillStyle='#fff';ctx.strokeStyle='#dce5e8';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(pad,y,width-pad*2,receiptH,14);ctx.fill();ctx.stroke();ctx.fillStyle='#087f8c';ctx.textAlign='center';ctx.font='bold 18px Arial';ctx.fillText('JT WATER REFILLING',width/2,y+24);ctx.fillStyle='#26383e';ctx.font='bold 23px Arial';ctx.fillText('OFFICIAL RECEIPT',width/2,y+57);ctx.fillStyle='#687980';ctx.font='14px Arial';ctx.fillText(String(r.receiptNumber||'-'),width/2,y+91);ctx.strokeStyle='#dce5e8';ctx.beginPath();ctx.moveTo(pad+28,y+124);ctx.lineTo(width-pad-28,y+124);ctx.stroke();ctx.textAlign='left';const fields=[['Order ID',r.orderId],['Customer',r.customerName],['Customer ID',r.customerId],['Payment Method',r.paymentMethod||'Unknown'],['Date & Time',r.dateTime],['Status',r.status||'Approved']];let yy=y+145;fields.forEach(([label,val])=>{ctx.fillStyle='#687980';ctx.font='14px Arial';ctx.fillText(label,pad+30,yy);ctx.fillStyle='#26383e';ctx.font='bold 14px Arial';ctx.fillText(String(val||'-').slice(0,65),pad+210,yy);yy+=rowH;});ctx.strokeStyle='#dce5e8';ctx.beginPath();ctx.moveTo(pad+28,y+receiptH-55);ctx.lineTo(width-pad-28,y+receiptH-55);ctx.stroke();ctx.fillStyle='#26383e';ctx.font='bold 16px Arial';ctx.fillText('TOTAL PAID',pad+30,y+receiptH-39);ctx.textAlign='right';ctx.font='bold 22px Arial';ctx.fillText(money(r.totalAmount),width-pad-30,y+receiptH-43);y+=receiptH+30;});
 const mime=format==='jpg'?'image/jpeg':'image/png';const link=document.createElement('a');link.download=`jt-official-receipts.${format==='jpg'?'jpg':'png'}`;link.href=canvas.toDataURL(mime,0.94);link.click();
}
window.approvePayment=async(paymentId,orderId)=>{if(window.__jtApprovingPayments?.has(paymentId)){return;}if(!window.__jtApprovingPayments)window.__jtApprovingPayments=new Set();if(!await window.showConfirmModal({ title: "Please confirm", message: 'Have you verified the actual GCash transaction or checked the screenshot in Messenger? Approve and create one official sale/receipt?', confirmText: "Confirm", cancelText: 'Cancel', danger: false }))return;if(window.__jtApprovingPayments.has(paymentId))return;window.__jtApprovingPayments.add(paymentId);const hideLoading=showJTLoading('Approving GCash payment…');try{const result=await apiApproveGCashPayment(paymentId,orderId);await loadVerifyPayments();window.showToast('Payment approved. Receipt No: '+result.receiptNumber, "success");}catch(e){const message=String(e?.message||'');if(message.includes('already has an official sale or receipt')||message.includes('already paid')){try{await loadVerifyPayments();window.showToast('This payment has already been processed. The payment list has been refreshed.', "info");}catch(refreshError){window.showToast('This payment may already be processed. Please refresh the payment list.', "info");}}else{window.showToast('Could not approve payment: '+message, "error");}}finally{window.__jtApprovingPayments.delete(paymentId);hideLoading();}};
window.rejectPayment=async(paymentId,orderId)=>{const reason=await window.showPromptModal({ title: 'Reject payment', message: 'Enter the reason for rejecting this payment (optional).', placeholder: 'Reason for rejection', initialValue: 'Could not verify payment', confirmText: 'Reject payment', danger: true });if(reason===null)return;const hideLoading=showJTLoading('Updating payment status…');try{await apiRejectGCashPayment(paymentId,orderId,reason);await loadVerifyPayments();window.showToast('Payment rejected. Customer can resubmit the details.', "success");}catch(e){window.showToast('Could not reject payment: '+e.message, "error");}finally{hideLoading();}};

window.jtPrepareImageData = async function(file, preserveQr=false) {
 if(!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
 if(file.size>12*1024*1024) throw new Error('Image must be 12 MB or smaller.');
 const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Could not read image.'));r.readAsDataURL(file);});
 const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Could not open image.'));i.src=src;});
 const max=preserveQr?900:1400,scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image processing is not supported.');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);let data=canvas.toDataURL(preserveQr?'image/png':'image/jpeg',preserveQr?undefined:.76);if(data.length>720000&&!preserveQr)data=canvas.toDataURL('image/jpeg',.62);if(data.length>720000)throw new Error('Image is too large after resizing. Please choose a smaller image.');return data;
};
window.viewPaymentProof = function(paymentId) { const src=window.__jtPaymentProofs?.[paymentId]; if(!src){window.showToast('No proof image was attached to this payment.','error');return;} const modal=document.createElement('div');modal.className='gcash-image-viewer';modal.innerHTML='<button type="button" class="gcash-image-viewer-close" aria-label="Close proof preview">×</button><img alt="Customer payment proof">';modal.querySelector('img').src=src;const close=()=>modal.remove();modal.querySelector('button').onclick=close;modal.addEventListener('click',e=>{if(e.target===modal)close();});document.addEventListener('keydown',function escProof(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',escProof);}});document.body.appendChild(modal);};

async function openGcashSettingsModal(){
 let modal=document.getElementById('gcash-settings-modal');
 if(!modal){
  modal=document.createElement('div');
  modal.id='gcash-settings-modal';
  modal.className='gcash-settings-modal';
  modal.hidden=true;
  modal.innerHTML=`<div class="gcash-settings-backdrop" data-close-gcash-settings></div>
   <section class="gcash-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="gcash-settings-title">
    <header class="gcash-settings-modal-header"><div><h2 id="gcash-settings-title">Station &amp; GCash Settings</h2><p>Manage store details, optional delivery fees, and payment information.</p></div><button type="button" class="gcash-settings-close" aria-label="Close settings" data-close-gcash-settings><span aria-hidden="true">×</span></button></header>
    <form id="gcash-settings-modal-form" class="gcash-settings-form">
     <div class="form-group"><label for="gcash-modal-qr">Owner GCash QR Image</label><input id="gcash-modal-qr" type="file" accept="image/png,image/jpeg,image/webp"><small class="gcash-settings-help">Upload the station's official GCash QR image. Use a clear, uncropped image with good contrast; PNG is recommended for sharp QR details. Keep the full QR code and its edges visible.</small><div class="gcash-qr-settings-preview" id="gcash-qr-settings-preview" hidden><img id="gcash-qr-settings-img" alt="GCash QR preview"><button type="button" id="gcash-qr-remove" class="gcash-qr-remove">Remove QR</button></div></div>
     <div class="form-group"><label for="gcash-modal-instructions">Payment Instructions</label><textarea id="gcash-modal-instructions" maxlength="500" placeholder="Send the exact amount. Payment will remain pending until the Owner verifies the actual transaction."></textarea></div>
     <hr><h3>Station Details</h3><div class="form-group"><label for="station-modal-address">Store Address</label><textarea id="station-modal-address" maxlength="300" required></textarea></div><div class="form-group"><label for="station-modal-hours">Operating Hours</label><input id="station-modal-hours" maxlength="100" required placeholder="7:00 AM - 4:00 PM"></div><div class="form-group"><label for="station-modal-contact">Store Contact Number</label><input id="station-modal-contact" type="tel" maxlength="30" placeholder="e.g. 09XXXXXXXXX" autocomplete="tel"></div><hr><h3>Delivery Fee</h3><label class="settings-toggle-row" for="station-modal-fee-enabled"><span class="settings-toggle-copy">Enable delivery fee</span><input id="station-modal-fee-enabled" type="checkbox" role="switch" aria-label="Enable delivery fee"><span class="settings-toggle-track" aria-hidden="true"><span></span></span><span class="settings-toggle-state" id="station-modal-fee-state">Off</span></label><div class="form-group"><label for="station-modal-fee-amount">Delivery Fee Amount (₱)</label><input id="station-modal-fee-amount" type="number" min="0" max="10000" step="0.01" value="0"></div>
     <footer class="gcash-settings-modal-actions"><button type="button" class="gcash-settings-cancel" data-close-gcash-settings>Cancel</button><button type="submit" class="gcash-settings-save">Save Settings</button></footer>
    </form>
   </section>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('[data-close-gcash-settings]').forEach(el=>el.addEventListener('click',()=>{modal.hidden=true;}));
  modal.addEventListener('click',e=>{if(e.target.classList.contains('gcash-settings-backdrop'))modal.hidden=true;});
  const feeToggle = modal.querySelector('#station-modal-fee-enabled');
  const feeAmount = modal.querySelector('#station-modal-fee-amount');
  const feeState = modal.querySelector('#station-modal-fee-state');
  const refreshFeeToggle = () => { feeAmount.disabled = !feeToggle.checked; feeState.textContent = feeToggle.checked ? 'On' : 'Off'; feeToggle.setAttribute('aria-checked', String(feeToggle.checked)); };
  feeToggle.addEventListener('change', refreshFeeToggle);
  refreshFeeToggle();
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal.hidden)modal.hidden=true;});
  modal._pendingQrImage = null; modal._removeQrImage = false;
  const qrInput = modal.querySelector('#gcash-modal-qr');
  const qrPreview = modal.querySelector('#gcash-qr-settings-preview');
  const qrPreviewImg = modal.querySelector('#gcash-qr-settings-img');
  const showQrPreview = src => { qrPreview.hidden = !src; if (src) qrPreviewImg.src = src; };
  qrInput.addEventListener('change', async () => { const file=qrInput.files?.[0]; if(!file)return; try { modal._pendingQrImage=await window.jtPrepareImageData(file,true); modal._removeQrImage=false; showQrPreview(modal._pendingQrImage); } catch(err) { qrInput.value=''; window.showToast(err.message,'error'); } });
  modal.querySelector('#gcash-qr-remove').addEventListener('click',()=>{modal._pendingQrImage=null;modal._removeQrImage=true;qrInput.value='';showQrPreview('');});
  modal.querySelector('#gcash-settings-modal-form').addEventListener('submit',async e=>{
   e.preventDefault();
   const save=modal.querySelector('.gcash-settings-save');window.setButtonLoading(save,true,'Saving…');
   try{
    await setDoc(doc(db,'paymentSettings','config'),{
     gcashQrImage: modal._removeQrImage ? '' : (modal._pendingQrImage || modal.dataset.currentQrImage || ''),
     instructions:modal.querySelector('#gcash-modal-instructions').value.trim(),
     stationAddress:modal.querySelector('#station-modal-address').value.trim(),
     operatingHours:modal.querySelector('#station-modal-hours').value.trim(),
     stationContactNumber:modal.querySelector('#station-modal-contact').value.trim(),
     deliveryFeeEnabled:modal.querySelector('#station-modal-fee-enabled').checked,
     deliveryFeeAmount:Math.max(0, Number(modal.querySelector('#station-modal-fee-amount').value || 0)),
     updatedBy:auth.currentUser.uid,
     updatedAt:serverTimestamp()
    });
    window.showToast('GCash settings saved.','success');modal.hidden=true;
   }catch(err){window.showToast('Could not save settings: '+err.message,'error');}
   finally{window.setButtonLoading(save,false);}
  });
 }
 modal.hidden=false;
 const form=modal.querySelector('#gcash-settings-modal-form');
 // Account-name and mobile-number fields were intentionally removed; QR image is the payment source of truth.
 form.querySelector('#gcash-modal-instructions').value='Send the exact amount. Payment will remain pending until the Owner verifies the actual transaction.';
 try{
  const snap=await getDoc(doc(db,'paymentSettings','config'));const d=snap.exists()?snap.data():{};
  modal._pendingQrImage=null; modal._removeQrImage=false; modal.dataset.currentQrImage=d.gcashQrImage||''; form.querySelector('#gcash-modal-qr').value=''; const qrPreview=form.querySelector('#gcash-qr-settings-preview'); const qrPreviewImg=form.querySelector('#gcash-qr-settings-img'); qrPreview.hidden=!d.gcashQrImage; if(d.gcashQrImage)qrPreviewImg.src=d.gcashQrImage;
  form.querySelector('#gcash-modal-instructions').value=d.instructions||'Send the exact amount. Payment will remain pending until the Owner verifies the actual transaction.';
  form.querySelector('#station-modal-address').value=d.stationAddress||'JT Water Refilling Station, 386 Sampaguita St., Brgy. Pansahan, Malolos, Bulacan';
  form.querySelector('#station-modal-hours').value=d.operatingHours||'7:00 AM - 4:00 PM';
  form.querySelector('#station-modal-contact').value=d.stationContactNumber||'';
  form.querySelector('#station-modal-fee-enabled').checked=d.deliveryFeeEnabled===true;
  form.querySelector('#station-modal-fee-amount').value=Number(d.deliveryFeeAmount||0);
  form.querySelector('#station-modal-fee-enabled').dispatchEvent(new Event('change'));
 }catch(e){window.showToast('Could not load settings: '+e.message,'error');}
 modal.querySelector('#gcash-modal-qr').focus();
}

async function loadProducts(){
 const c=document.getElementById('app-content');
 c.innerHTML=`<section class="products-page">
  <div class="products-page-heading"><div><h2>Products &amp; Prices</h2><p>Manage your product list, pricing, and availability.</p></div><span class="products-count" id="products-count">Loading…</span></div>
  <section class="products-form-card"><form id="product-form" class="products-form">
   <div class="products-form-heading"><div><h3 id="product-form-title">Add Product</h3><p>Add or update a product and its selling price.</p></div></div>
   <div class="products-form-grid">
    <div class="form-group"><label for="product-name">Product Name</label><input id="product-name" required maxlength="100" placeholder="e.g. Purified Water"></div>
    <div class="form-group"><label for="product-price">Price (₱)</label><input id="product-price" type="number" min="0.01" step="0.01" required placeholder="0.00"></div>
    <div class="form-group products-description-field"><label for="product-description">Description <span>(optional)</span></label><textarea id="product-description" maxlength="300" rows="2" placeholder="Short product description"></textarea></div>
    <div class="form-group products-image-field"><label for="product-image-file">Product Image <span>(optional · PNG/JPG/WebP, max 8 MB before compression)</span></label><input id="product-image-file" type="file" accept="image/png,image/jpeg,image/webp,image/*"><div class="product-image-editor-preview" id="product-image-preview-wrap" hidden><img id="product-image-preview" alt="Product image preview"><button type="button" id="product-image-remove" class="btn-secondary">Remove image</button></div><small class="products-image-help">Choose the image customers will see on their product card. The image is resized before saving.</small></div>
   </div>
   <div class="products-form-actions"><button class="btn-primary products-save-button" id="product-save-button" type="submit">Add Product</button><button class="btn-secondary" id="product-cancel-edit" type="button" hidden>Cancel edit</button></div>
  </form></section>
  <section class="products-list-section"><div class="products-list-heading"><div><h3>Product List</h3><p>Active products can be ordered by customers.</p></div><label class="products-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="products-search-input" type="search" placeholder="Search products…" aria-label="Search products"></label></div><div id="products-list" class="products-grid"><p class="products-empty">Loading products…</p></div></section>
 </section>`;
 const target=document.getElementById('products-list'), form=document.getElementById('product-form');
 const search=document.getElementById('products-search-input'); let products=[], editingId=null, selectedImageData='', clearExistingImage=false;
 const imageInput=document.getElementById('product-image-file'), imagePreviewWrap=document.getElementById('product-image-preview-wrap'), imagePreview=document.getElementById('product-image-preview');
 function setImagePreview(value){selectedImageData=value||'';if(selectedImageData)clearExistingImage=false;imagePreview.src=selectedImageData;imagePreviewWrap.hidden=!selectedImageData;}
 function resetForm(){editingId=null;clearExistingImage=false;form.reset();setImagePreview('');document.getElementById('product-form-title').textContent='Add Product';document.getElementById('product-save-button').textContent='Add Product';document.getElementById('product-cancel-edit').hidden=true;}
 function render(){const q=search.value.trim().toLowerCase();const filtered=products.filter(p=>`${p.name||''} ${p.description||''}`.toLowerCase().includes(q));document.getElementById('products-count').textContent=`${products.length} ${products.length===1?'product':'products'}`;
  if(!filtered.length){target.innerHTML=`<div class="products-empty"><span class="products-empty-icon">▣</span><strong>${products.length?'No matching products':'No products yet'}</strong><span>${products.length?'Try another search term.':'Add your first product using the form above.'}</span></div>`;return;}
  target.innerHTML=filtered.map(p=>`<article class="product-item-card ${p.active===false?'product-inactive':''}"><div class="product-item-main">${p.imageUrl||p.image?`<div class="product-item-image"><img src="${esc(p.imageUrl||p.image)}" alt=""></div>`:`<div class="product-item-icon" aria-hidden="true">▣</div>`}<div class="product-item-copy"><h4>${esc(p.name||'Unnamed product')}</h4><p>${esc(p.description||'No description provided')}</p></div></div><div class="product-item-meta"><strong class="product-item-price">₱${Number(p.price||0).toFixed(2)}</strong><span class="product-status ${p.active===false?'product-status-inactive':'product-status-active'}">${p.active===false?'Inactive':'Active'}</span></div><div class="product-item-actions"><button type="button" class="btn-secondary product-edit-btn" data-product-action="edit" data-product-id="${p.id}">Edit</button><button type="button" class="btn-secondary" data-product-action="toggle" data-product-id="${p.id}" data-active="${p.active===false?'true':'false'}">${p.active===false?'Activate':'Deactivate'}</button><button type="button" class="btn-danger product-remove-btn" data-product-action="remove" data-product-id="${p.id}">Remove</button></div></article>`).join('');
 }
 imageInput.addEventListener('change',async()=>{const file=imageInput.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){window.showToast('Please choose an image file.','error');imageInput.value='';return;}if(file.size>8*1024*1024){window.showToast('Please choose an image smaller than 8 MB.','error');imageInput.value='';return;}try{const data=await compressProductImage(file);setImagePreview(data);}catch(err){window.showToast('Could not read that image. Please try another file.','error');imageInput.value='';}});
 document.getElementById('product-image-remove').addEventListener('click',()=>{clearExistingImage=true;setImagePreview('');imageInput.value='';});
 function compressProductImage(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const max=480,scale=Math.min(1,max/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);let out=canvas.toDataURL('image/webp',.78);if(!out.startsWith('data:image/webp'))out=canvas.toDataURL('image/jpeg',.76);if(out.length>700000){out=canvas.toDataURL('image/jpeg',.62);}if(out.length>900000){reject(new Error('Image is too large after compression.'));return;}resolve(out);};img.src=reader.result;};reader.readAsDataURL(file);});}
 async function refresh(){const snap=await getDocs(collection(db,'products'));products=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.name||'').localeCompare(b.name||''));render();}
 try{await refresh();}catch(e){target.innerHTML=`<p class="error-msg">${esc(e.message)}</p>`;}
 search.addEventListener('input',render);
 document.getElementById('product-cancel-edit').addEventListener('click',resetForm);
 form.addEventListener('submit',async e=>{e.preventDefault();const existing=products.find(p=>p.id===editingId);const data={name:document.getElementById('product-name').value.trim(),price:Number(document.getElementById('product-price').value),description:document.getElementById('product-description').value.trim(),imageUrl:selectedImageData||(clearExistingImage?'':(existing?.imageUrl||existing?.image||'')),updatedAt:serverTimestamp()};try{const saveButton=document.getElementById('product-save-button');saveButton.disabled=true;saveButton.textContent='Saving…';if(editingId){await updateDoc(doc(db,'products',editingId),data);window.showToast('Product updated.','success');}else{await addDoc(collection(db,'products'),{...data,active:true,createdAt:serverTimestamp()});window.showToast('Product added.','success');}resetForm();await refresh();}catch(err){window.showToast('Could not save product: '+err.message,'error');}finally{const saveButton=document.getElementById('product-save-button');saveButton.disabled=false;saveButton.textContent=editingId?'Save Changes':'Add Product';}});
 target.addEventListener('click',async e=>{const btn=e.target.closest('[data-product-action]');if(!btn)return;const id=btn.dataset.productId, action=btn.dataset.productAction, product=products.find(p=>p.id===id);if(!product)return;
  if(action==='edit'){editingId=id;document.getElementById('product-name').value=product.name||'';document.getElementById('product-price').value=Number(product.price||0);document.getElementById('product-description').value=product.description||'';imageInput.value='';setImagePreview(product.imageUrl||product.image||'');document.getElementById('product-form-title').textContent='Edit Product';document.getElementById('product-save-button').textContent='Save Changes';document.getElementById('product-cancel-edit').hidden=false;document.getElementById('product-name').focus();document.querySelector('.products-form-card').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(action==='toggle'){const active=btn.dataset.active==='true';if(!active&&!(await window.showConfirmModal({title:'Deactivate product?',message:'Customers will no longer be able to order this product. Continue?',confirmText:'Deactivate',cancelText:'Cancel',danger:true})))return;try{await updateDoc(doc(db,'products',id),{active,updatedAt:serverTimestamp()});window.showToast(active?'Product activated.':'Product deactivated.','success');await refresh();}catch(err){window.showToast('Could not update product: '+err.message,'error');}return;}
  if(action==='remove'){if(!(await window.showConfirmModal({title:'Remove product permanently?',message:`This will permanently delete “${product.name||'this product'}” from the product list. This cannot be undone. If you only want to hide it from customers, choose Deactivate instead.`,confirmText:'Remove permanently',cancelText:'Cancel',danger:true})))return;try{await deleteDoc(doc(db,'products',id));if(editingId===id)resetForm();window.showToast('Product removed.','success');await refresh();}catch(err){window.showToast('Could not remove product: '+err.message,'error');}}
 });
}
async function loadStaffDrivers() {
 const c=document.getElementById('app-content');
 window.__jtAccountsTab='team';
 c.innerHTML=`${accountsTabs('team')}
 <div class="customer-toolbar team-toolbar"><button type="button" class="btn-primary team-add-button" id="add-team-account-btn">+ Staff / Drivers</button><label class="customer-search team-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="team-search-input" type="search" placeholder="Search staff or driver name, email, or phone…" aria-label="Search staff and drivers"></label></div>
 <section class="customer-section team-section" style="margin-top:1rem"><div id="team-accounts-list">Loading staff and drivers...</div></section>
 <div class="customer-modal-backdrop" id="create-team-account-modal" hidden><section class="customer-details-modal create-team-modal" role="dialog" aria-modal="true" aria-labelledby="create-team-title"><button class="customer-modal-close" id="close-team-account-modal" aria-label="Close" type="button">×</button><h2 id="create-team-title">Add Staff / Driver</h2><p>Create an account for a team member.</p><form id="create-team-account-form"><div class="form-group"><label for="team-role">Account type</label><select id="team-role"><option value="staff">Staff</option><option value="driver">Driver</option></select></div><div class="form-group"><label for="team-name">Full Name</label><input id="team-name" required></div><div class="form-group"><label for="team-email">Email Address</label><input type="email" id="team-email" required></div><div class="form-group"><label for="team-phone">Phone Number</label><input type="tel" id="team-phone" required></div><div class="form-group"><label for="team-password">Temporary Password (minimum 6 characters)</label><input type="password" id="team-password" minlength="6" required></div><button type="submit" class="btn-primary">Create Account</button></form></section></div>`;
 const search=document.getElementById('team-search-input');
 search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase();document.querySelectorAll('#team-accounts-list .customer-row').forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(q);});});
 const modal=document.getElementById('create-team-account-modal');
 document.getElementById('add-team-account-btn').addEventListener('click',()=>{modal.hidden=false;});
 document.getElementById('close-team-account-modal').addEventListener('click',()=>{modal.hidden=true;});
 modal.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true;});
 document.getElementById('create-team-account-form').addEventListener('submit',async e=>{e.preventDefault();const role=document.getElementById('team-role').value;try{await apiCreateUserAccount({fullName:document.getElementById('team-name').value.trim(),email:document.getElementById('team-email').value.trim(),phoneNumber:document.getElementById('team-phone').value.trim(),password:document.getElementById('team-password').value,role});window.showToast(`${role==='staff'?'Staff':'Driver'} account created successfully.`,'success');e.target.reset();modal.hidden=true;await refreshRoleAccounts();}catch(err){window.showToast('Could not create account: '+err.message,'error');}});
 await refreshRoleAccounts();
}
async function refreshRoleAccounts() {
 const target=document.getElementById('team-accounts-list'); if(!target)return;
 try {
  const snap=await getDocs(collection(db,'users')); const users=[];
  snap.forEach(d=>{const u=d.data();if(['staff','driver'].includes(u.role))users.push({id:d.id,...u});});
  users.sort((a,b)=>String(a.fullName||a.email||'').localeCompare(String(b.fullName||b.email||'')));
  if(!users.length){target.innerHTML='<p class="customer-empty">No staff or driver accounts yet.</p>';return;}
  target.innerHTML=`<div class="customer-list">${users.map(u=>{const role=u.role,removed=u.isActive===false||u.status==='removed';const address=u.address||u.deliveryAddress||'';return `<article class="customer-row team-account-row"><div class="customer-main"><div class="customer-name-line"><span class="account-type-icon ${role==='driver'?'driver-type-icon':'staff-type-icon'}" aria-hidden="true">${role==='driver'?'<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h10a1.5 1.5 0 0 1 1.5 1.5V7H18a2 2 0 0 1 1.55.74l2.2 2.7c.16.2.25.46.25.72v5.09A1.75 1.75 0 0 1 20.25 18H20a3 3 0 0 1-5.9 0H9.9A3 3 0 0 1 4 18h-.25A1.75 1.75 0 0 1 2 16.25V5.5h.5ZM15.5 9v3h4.2l-1.8-2.2a1 1 0 0 0-.78-.38H15.5ZM7 19.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm10 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"/></svg>':'<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg>'}</span><div class="customer-name">${esc(u.fullName||'-')}</div></div><div class="customer-address">${esc(u.email||'-')} · ${esc(u.phoneNumber||'-')}</div><div class="customer-mobile-details team-full-details"><div><b>Email</b><span>${esc(u.email||'-')}</span></div><div><b>Phone</b><span>${esc(u.phoneNumber||'-')}</span></div><div><b>Role</b><span>${role==='staff'?'Staff':'Driver'}</span></div><div><b>Address</b><span>${esc(address||'Not provided')}</span></div></div></div><div class="customer-actions"><span class="badge team-role-badge">${role==='staff'?'Staff':'Driver'}</span><button class="btn-secondary team-desktop-action team-remove-permanent" onclick="window.removeTeamAccount('${esc(u.id)}','${role}')">Remove</button><button class="customer-more team-overflow-button" type="button" aria-label="Account actions" title="Account actions" onclick="window.showTeamAccountMenu('${esc(u.id)}','${role}')">⋮</button></div></article>`;}).join('')}</div>`;
 } catch(e){target.innerHTML=`<p class="error-msg">Could not load accounts: ${esc(e.message)}</p>`;}
}
window.showTeamAccountMenu=async(uid,role)=>{try{const snap=await getDoc(doc(db,'users',uid));if(!snap.exists())throw new Error('Account not found.');const u=snap.data();let modal=document.getElementById('team-account-actions-modal');if(!modal){modal=document.createElement('div');modal.id='team-account-actions-modal';modal.className='customer-modal-backdrop team-actions-backdrop';modal.innerHTML=`<section class="customer-details-modal team-actions-modal" role="dialog" aria-modal="true" aria-labelledby="team-actions-title"><button class="customer-modal-close" type="button" aria-label="Close">×</button><h2 id="team-actions-title">Account actions</h2><p class="team-actions-name"></p><div class="team-actions-buttons"></div></section>`;modal.querySelector('.customer-modal-close').onclick=()=>modal.remove();modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});document.body.appendChild(modal);}modal.querySelector('.team-actions-name').textContent=u.fullName||u.email||'Team account';modal.querySelector('.team-actions-buttons').innerHTML=`<button type="button" class="btn-secondary" data-team-view>View full details</button><button type="button" class="btn-secondary team-remove-danger" data-team-delete>Delete account permanently</button>`;modal.querySelector('[data-team-view]').onclick=()=>{modal.remove();window.showTeamAccountDetails(uid,role);};modal.querySelector('[data-team-delete]').onclick=async()=>{modal.remove();await window.removeTeamAccount(uid,role);};}catch(e){window.showToast('Could not load account actions: '+e.message,'error');}};
window.removeTeamAccount=async(uid,role)=>{if(!await window.showConfirmModal({title:`Delete ${role==='staff'?'Staff':'Driver'} account permanently?`,message:'This permanently deletes the account profile from the users collection. It cannot be restored from Removed Customers. Existing orders and delivery records are not deleted. Firebase Authentication sign-in credentials may still require an administrator-side deletion.',confirmText:'Delete permanently',cancelText:'Cancel',danger:true}))return;try{const ref=doc(db,'users',uid);const snap=await getDoc(ref);if(!snap.exists()||snap.data().role!==role)throw new Error('Account not found. Refresh the list.');await deleteDoc(ref);window.showToast('Account profile permanently deleted.','success');await refreshRoleAccounts();}catch(e){window.showToast('Could not delete account: '+e.message,'error');}};
window.showTeamAccountDetails=async(uid,role)=>{try{const snap=await getDoc(doc(db,'users',uid));if(!snap.exists())throw new Error('Account not found.');const u=snap.data();let modal=document.getElementById('customer-details-modal');if(!modal){modal=document.createElement('div');modal.id='customer-details-modal';modal.className='customer-modal-backdrop';modal.innerHTML=`<section class="customer-details-modal" role="dialog" aria-modal="true"><button class="customer-modal-close" aria-label="Close" type="button">×</button><h2>Account Details</h2><div class="customer-modal-content"></div></section>`;modal.querySelector('.customer-modal-close').onclick=()=>modal.remove();modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});document.body.appendChild(modal);}modal.querySelector('.customer-modal-content').innerHTML=`<div class="customer-profile-head"><span class="customer-avatar">${role==='driver'?'<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h10a1.5 1.5 0 0 1 1.5 1.5V7H18a2 2 0 0 1 1.55.74l2.2 2.7c.16.2.25.46.25.72v5.09A1.75 1.75 0 0 1 20.25 18H20a3 3 0 0 1-5.9 0H9.9A3 3 0 0 1 4 18h-.25A1.75 1.75 0 0 1 2 16.25V5.5h.5ZM15.5 9v3h4.2l-1.8-2.2a1 1 0 0 0-.78-.38H15.5ZM7 19.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm10 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"/></svg>':'<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 12a4.25 4.25 0 1 0 0-8.5A4.25 4.25 0 0 0 12 12Zm-8 8.5v-1.25a6.75 6.75 0 0 1 6.75-6.75h2.5A6.75 6.75 0 0 1 20 19.25v1.25H4Z"/></svg>'}</span><div><h3>${esc(u.fullName||'-')}</h3><span>${role==='staff'?'Staff':'Driver'}</span></div></div><dl class="customer-info-grid"><div><dt>Email</dt><dd>${esc(u.email||'-')}</dd></div><div><dt>Phone</dt><dd>${esc(u.phoneNumber||'-')}</dd></div><div class="customer-address-full"><dt>Address</dt><dd>${esc(u.address||u.deliveryAddress||'Not provided')}</dd></div></dl>`;}catch(e){window.showToast('Could not load account details: '+e.message,'error');}};
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function loadDeliveryAssignments() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
        <div class="delivery-page">
            <header class="delivery-page-heading">
                <div><h2>Delivery Assignments</h2><p>Review pending deliveries and assign an active driver.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-secondary" id="delivery-refresh">↻ Refresh</button></div>
            </header>
            <section class="delivery-section">
                <div class="delivery-section-heading">
                    <div><h3>Delivery Management</h3><p>Assign new deliveries or review unsuccessful delivery attempts.</p></div>
                    <span class="delivery-count" id="delivery-count">Loading…</span>
                </div>
                <div class="accounts-tabs accounts-tabs-two delivery-tabs" role="tablist" aria-label="Delivery lists">
                    <button type="button" class="accounts-tab delivery-tab active" data-delivery-tab="pending" role="tab" aria-selected="true"><span class="accounts-tab-icon" aria-hidden="true">↗</span><span>Pending Deliveries</span></button>
                    <button type="button" class="accounts-tab delivery-tab" data-delivery-tab="failed" role="tab" aria-selected="false"><span class="accounts-tab-icon" aria-hidden="true">!</span><span>Failed Deliveries</span></button>
                </div>
                <label class="customer-search delivery-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="delivery-search-input" type="search" placeholder="Search order, customer, address, or status…" aria-label="Search delivery assignments"></label>
                <div id="assignment-list" class="delivery-list-wrap">Loading delivery orders...</div>
            </section>
        </div>
    `;

    const target = document.getElementById('assignment-list');
    const search = document.getElementById('delivery-search-input');
    let deliveryTab = 'pending';
    document.getElementById('delivery-refresh')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        if (button.disabled) return;
        const previousLabel = button.textContent;
        button.disabled = true;
        button.textContent = 'Refreshing…';
        try {
            await loadDeliveryAssignments();
        } finally {
            // loadDeliveryAssignments re-renders the heading and its button.
        }
    });

    try {
        const [ordersSnap, usersSnap] = await Promise.all([
            getDocs(collection(db, 'orders')),
            getDocs(collection(db, 'users'))
        ]);

        const drivers = [];
        usersSnap.forEach(d => {
            const user = d.data();
            if (user.role === 'driver' && user.isActive === true && user.status !== 'removed') {
                drivers.push({ id: d.id, name: user.fullName || user.email || d.id });
            }
        });
        drivers.sort((a,b)=>a.name.localeCompare(b.name));

        const deliveries = [];
        ordersSnap.forEach(d => {
            const order = d.data();
            if (order.type === 'delivery') deliveries.push({ id: d.id, ...order });
        });
        deliveries.sort((a,b)=>{
            const at=a.createdAt?.toMillis?.() ?? (a.createdAt?.seconds ? a.createdAt.seconds*1000 : 0);
            const bt=b.createdAt?.toMillis?.() ?? (b.createdAt?.seconds ? b.createdAt.seconds*1000 : 0);
            return bt-at;
        });
        function renderDeliveryList() {
            const failedTab = deliveryTab === 'failed';
            const visibleOrders = deliveries.filter(order => failedTab
                ? String(order.deliveryStatus || '').toLowerCase() === 'failed'
                : !['completed','failed','cancelled'].includes(String(order.deliveryStatus || 'pending').toLowerCase()));
            document.getElementById('delivery-count').textContent = `${visibleOrders.length} ${visibleOrders.length===1?'delivery':'deliveries'}`;
            if (!visibleOrders.length) {
                target.innerHTML = failedTab
                    ? '<div class="delivery-empty"><span class="delivery-empty-icon" aria-hidden="true">✓</span><strong>No failed deliveries</strong><p>Unsuccessful delivery attempts will appear here for customer follow-up.</p></div>'
                    : '<div class="delivery-empty"><span class="delivery-empty-icon" aria-hidden="true">✓</span><strong>No pending deliveries</strong><p>All delivery orders are assigned, completed, cancelled, or there are no delivery orders to assign.</p></div>';
                return;
            }
            if (!drivers.length && !failedTab) {
                target.innerHTML = '<div class="delivery-empty"><strong>No active drivers found</strong><p>Create or activate a Driver account before assigning deliveries.</p></div>';
                return;
            }
            target.innerHTML = `<div class="delivery-cards">${visibleOrders.map(order=>{
                const id=esc(order.id);
                const assigned=drivers.find(d=>d.id===order.assignedDriverId);
                const options=drivers.map(driver=>`<option value="${esc(driver.id)}" ${order.assignedDriverId===driver.id?'selected':''}>${esc(driver.name)}</option>`).join('');
                const status=String(order.deliveryStatus||'pending').toLowerCase();
                const paymentBlocked=order.paymentMethod==='online' && order.paymentStatus!=='paid';
                const searchText=[order.id,order.customerName,order.customerId,order.deliveryAddress,order.deliveryStatus,assigned?.name,order.paymentStatus].join(' ').toLowerCase();
                const history=Array.isArray(order.deliveryAttemptHistory)?order.deliveryAttemptHistory:[];
                const latest=history.length?history[history.length-1]:null;
                if (failedTab) return `<article class="delivery-order-card delivery-order-row" data-search="${esc(searchText)}">
                    <div class="delivery-customer-cell"><span class="delivery-customer-icon" aria-hidden="true">!</span><div class="delivery-customer-main"><strong class="delivery-customer-name">${esc(order.customerName||'Customer name unavailable')}</strong><span class="delivery-order-id">Order #${esc(order.id.slice(0,8))}</span></div></div>
                    <div class="delivery-row-detail"><span>Address / Contact</span><strong>${esc(order.deliveryAddress||'Not provided')} · ${esc(order.contactNumber||'No phone')}</strong></div>
                    <div class="delivery-row-detail"><span>Attempts recorded</span><strong>${history.length}</strong></div>
                    <div class="delivery-row-detail"><span>Last attempt</span><strong>${esc(latest?.reason||order.failureReason||'Reason not recorded')}</strong></div>
                    ${history.length?`<div class="delivery-row-detail delivery-attempt-history"><span>Attempt history</span><strong>${history.map((attempt,index)=>`${index+1}. ${esc(attempt.reason||'Reason not recorded')} · ${esc(attempt.failedAt||'Date unavailable')}`).join(' | ')}</strong></div>`:''}
                    <div class="delivery-row-detail"><span>Payment</span><strong>${esc(statusLabel(order.paymentMethod||'cod'))} · ${esc(statusLabel(order.paymentStatus||'unpaid'))}</strong></div>
                    <p class="workflow-note">Contact the customer and record their decision before retrying or cancelling. Failed orders are excluded from Pending Deliveries.</p>
                    <div class="delivery-order-actions"><button type="button" class="delivery-assign-button" onclick="window.resolveFailedDelivery('${id}','retry')">Customer confirmed retry</button><button type="button" class="btn-secondary" onclick="window.resolveFailedDelivery('${id}','cancel')">Cancel order</button></div>
                </article>`;
                return `<article class="delivery-order-card delivery-order-row" data-search="${esc(searchText)}">
                    <div class="delivery-customer-cell"><span class="delivery-customer-icon" aria-hidden="true">♙</span><div class="delivery-customer-main"><strong class="delivery-customer-name">${esc(order.customerName||'Customer name unavailable')}</strong><span class="delivery-order-id">Order #${esc(order.id.slice(0,8))}</span></div></div>
                    <div class="delivery-row-detail"><span>Address</span><strong>${esc(order.deliveryAddress||'Not provided')}</strong></div>
                    <div class="delivery-row-detail delivery-assigned-detail"><span>Driver</span><strong>${esc(assigned?.name||'Not assigned')}</strong></div>
                    ${history.length?`<div class="delivery-row-detail delivery-attempt-history"><span>Previous attempts (${history.length})</span><strong>${history.map((attempt,index)=>`${index+1}. ${esc(attempt.reason||'Reason not recorded')} · ${esc(attempt.failedAt||'Date unavailable')}`).join(' | ')}</strong></div>`:''}
                    <span class="delivery-status-badge ${status==='pending'?'is-pending':'is-progress'}">${esc(statusLabel(order.deliveryStatus))}</span>
                    <div class="delivery-order-actions"><select id="driver-${id}" aria-label="Select driver for order ${id}" ${paymentBlocked?'disabled':''}><option value="">Select Driver</option>${options}</select><button type="button" class="delivery-assign-button" onclick="window.assignDeliveryDriver('${id}')" ${paymentBlocked?'disabled title="Verify GCash payment before assignment"':''}>Assign</button></div>
                    ${paymentBlocked?'<p class="workflow-note delivery-payment-hold">GCash payment must be verified before this delivery can be assigned.</p>':''}
                </article>`;
            }).join('')}</div>`;
            const applySearch = () => {
                const q=search.value.trim().toLowerCase();
                let visible=0;
                target.querySelectorAll('.delivery-order-card').forEach(card=>{const show=card.dataset.search.includes(q);card.hidden=!show;if(show)visible++;});
                let empty=target.querySelector('.delivery-search-empty');
                if(!visible){if(!empty){empty=document.createElement('div');empty.className='delivery-empty delivery-search-empty';empty.textContent='No deliveries match your search.';target.appendChild(empty);}}
                else empty?.remove();
            };
            applySearch();
        }
        document.querySelectorAll('[data-delivery-tab]').forEach(tab => tab.addEventListener('click', () => {
            deliveryTab = tab.dataset.deliveryTab;
            document.querySelectorAll('[data-delivery-tab]').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
            renderDeliveryList();
        }));
        search.addEventListener('input', renderDeliveryList);
        renderDeliveryList();
    } catch (error) {
        target.innerHTML = `<p class="error-msg">Could not load delivery assignments: ${esc(error.message)}</p>`;
    }
}

window.resolveFailedDelivery = async function(orderId, decision) {
    if (!['retry','cancel'].includes(decision)) return;
    const message = decision === 'retry'
        ? 'Confirm that you contacted the customer and they agreed to another delivery attempt. The order will return to Pending Deliveries and must be assigned to a driver.'
        : 'Confirm that the customer agreed to cancel this order. Any online payment/refund must be handled separately; this action will not create a refund.';
    if (!(await window.showConfirmModal({title: decision === 'retry' ? 'Retry failed delivery?' : 'Cancel failed order?', message, confirmText: decision === 'retry' ? 'Confirm retry' : 'Cancel order', cancelText: 'Go back', danger: decision === 'cancel'}))) return;
    try {
        const ref = doc(db, 'orders', orderId);
        const snap = await getDoc(ref);
        if (!snap.exists()) throw new Error('Order not found.');
        const order = snap.data();
        if (order.type !== 'delivery' || order.deliveryStatus !== 'failed') throw new Error('This order is no longer in Failed Deliveries. Refresh and try again.');
        if (decision === 'cancel' && order.paymentMethod === 'online' && order.paymentStatus === 'paid') throw new Error('This paid online order cannot be cancelled here until Admin completes the refund review. The payment and official sale remain recorded.');
        const update = {
            deliveryStatus: decision === 'retry' ? 'ready_for_dispatch' : 'cancelled',
            failedDeliveryDecision: decision,
            failedDeliveryDecisionAt: serverTimestamp(),
            failedDeliveryDecisionBy: auth.currentUser.uid,
            updatedAt: serverTimestamp()
        };
        if (decision === 'retry') update.assignedDriverId = deleteField();
        await updateDoc(ref, update);
        window.showToast(decision === 'retry' ? 'Delivery returned to Pending Deliveries. Assign a driver when ready.' : 'Failed delivery order cancelled. Payment/refund status was not changed.', 'success');
        await loadDeliveryAssignments();
    } catch (error) {
        window.showToast('Could not resolve failed delivery: ' + error.message, 'error');
    }
};

window.assignDeliveryDriver = async function(orderId) {
    const select = document.getElementById(`driver-${orderId}`);
    const driverId = select?.value;

    if (!driverId) {
        window.showToast('Please select a Driver.', 'error');
        return;
    }

    if (!(await window.showConfirmModal({title:'Assign delivery?',message:'Assign this delivery to the selected Driver?',confirmText:'Assign Driver',cancelText:'Cancel'}))) {
        return;
    }

    try {
        await apiAssignDriver(orderId, driverId);
        window.showToast('Driver assigned successfully.', 'success');
        loadDeliveryAssignments();
    } catch (error) {
        window.showToast('Could not assign Driver: ' + error.message, 'error');
    }
};


async function openAdminWalkInForm() {
    try {
        const productsSnap = await getDocs(collection(db, 'products'));
        const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.active !== false && Number(p.price) > 0);
        if (!products.length) { window.showToast('No active products are available for walk-in orders.', 'error'); return; }
        const optionHtml = products.map(p => `<option value="${esc(p.id)}" data-name="${esc(p.name || 'Product')}" data-price="${Number(p.price)}">${esc(p.name || 'Product')} — ₱${Number(p.price).toFixed(2)}</option>`).join('');
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,35,45,.58)';
        modal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="admin-walkin-title" style="box-sizing:border-box;background:var(--surface,#fff);color:var(--text,#193b43);border:1px solid var(--border,#d7e6e9);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.22);max-width:620px;width:100%;max-height:90vh;overflow:auto"><header style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border,#d7e6e9)"><h2 id="admin-walkin-title" style="margin:0;font-size:1.25rem">Create Walk-in Order</h2><button type="button" data-close aria-label="Close" style="border:0;border-radius:8px;padding:8px 12px;cursor:pointer">×</button></header><div style="padding:18px 20px"><p>Anonymous in-station pickup. No customer account or personal details required.</p><div id="admin-walkin-lines" style="display:grid;gap:10px"><div class="admin-walkin-line" style="display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:10px"><label style="display:grid;gap:6px;font-weight:600">Product<select class="admin-walkin-product" style="box-sizing:border-box;width:100%;min-width:0;padding:11px;border:1px solid var(--border,#d7e6e9);border-radius:8px">${optionHtml}</select></label><label style="display:grid;gap:6px;font-weight:600">Qty<input class="admin-walkin-qty" type="number" min="1" max="100" value="1" style="box-sizing:border-box;width:100%;padding:11px;border:1px solid var(--border,#d7e6e9);border-radius:8px"></label></div></div><p style="margin:10px 0 0;color:var(--text-secondary,#667);font-size:13px">One product type per walk-in order. Adjust the quantity for multiple gallons.</p><div style="margin:18px 0;padding:14px;background:var(--surface-secondary,#f4f8f8);border-radius:10px;display:flex;justify-content:space-between;gap:10px"><strong>Total</strong><strong id="admin-walkin-total">₱0.00</strong></div><fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:8px">Payment method</legend><label style="margin-right:18px"><input type="radio" name="admin-walkin-payment" value="cod" checked> Cash</label><label><input type="radio" name="admin-walkin-payment" value="online"> GCash</label></fieldset><p style="font-size:13px;color:var(--text-secondary,#667);margin-top:12px">Cash: confirm after receiving cash. GCash: order stays pending verification until Admin approves it. Handover is a separate action.</p></div><footer style="display:flex;justify-content:flex-end;gap:10px;padding:16px 20px;border-top:1px solid var(--border,#d7e6e9)"><button type="button" class="btn-secondary" data-close>Cancel</button><button type="button" class="btn-primary" id="admin-walkin-create">Create Order</button></footer></section>`;
        document.body.appendChild(modal);
        const lines = modal.querySelector('#admin-walkin-lines');
        const bindLine = row => { row.querySelector('.admin-walkin-product').addEventListener('change', updateTotal); row.querySelector('.admin-walkin-qty').addEventListener('input', updateTotal); };
        const updateTotal = () => { let total = 0; lines.querySelectorAll('.admin-walkin-line').forEach(row => total += Number(row.querySelector('.admin-walkin-product').selectedOptions[0]?.dataset.price || 0) * Math.max(1, Math.min(100, Number(row.querySelector('.admin-walkin-qty').value) || 1))); modal.querySelector('#admin-walkin-total').textContent = '₱' + total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); };
        modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => modal.remove()));
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        bindLine(lines.firstElementChild); updateTotal();
        modal.querySelector('#admin-walkin-create').addEventListener('click', async () => { const button=modal.querySelector('#admin-walkin-create'); if(button.disabled)return; button.disabled=true; button.textContent='Creating…'; try { const items=[...lines.querySelectorAll('.admin-walkin-line')].map(row=>{const sel=row.querySelector('.admin-walkin-product'),opt=sel.selectedOptions[0];return {productId:sel.value,name:opt.dataset.name,unitPrice:Number(opt.dataset.price),quantity:Number(row.querySelector('.admin-walkin-qty').value)};}); const method=modal.querySelector('input[name="admin-walkin-payment"]:checked').value; const result=await apiCreateWalkInOrder(items,method); window.showToast(`Walk-in order created: ${result.orderId}. Total ₱${result.totalAmount.toFixed(2)}. ${method==='online'?'Awaiting Admin GCash verification.':'Confirm cash received to issue the official receipt.'}`,'success',9000); modal.remove(); } catch(e) { window.showToast('Could not create walk-in order: '+e.message,'error',9000); button.disabled=false; button.textContent='Create Order'; } });
    } catch (e) { window.showToast('Could not open Walk-in Order: '+e.message,'error'); }
}


// Duplicate-action protection for Admin operations that write payment/order/account data.
window.reviewCancellationRequest = window.guardAsyncAction((orderId, decision='open') => `admin-cancellation:${orderId}:${decision === 'open' ? 'open' : 'review'}`, window.reviewCancellationRequest);
window.approvePayment = window.guardAsyncAction((paymentId, orderId) => `admin-payment-approve:${orderId || paymentId}`, window.approvePayment);
window.rejectPayment = window.guardAsyncAction((paymentId, orderId) => `admin-payment-reject:${orderId || paymentId}`, window.rejectPayment);
window.resolveFailedDelivery = window.guardAsyncAction((orderId) => `admin-failed-delivery:${orderId}`, window.resolveFailedDelivery);
window.assignDeliveryDriver = window.guardAsyncAction((orderId) => `admin-assign-driver:${orderId}`, window.assignDeliveryDriver);
window.removeTeamAccount = window.guardAsyncAction((uid) => `admin-remove-account:${uid}`, window.removeTeamAccount);
window.approveCustomer = window.guardAsyncAction((uid) => `admin-approve-customer:${uid}`, window.approveCustomer);
window.rejectCustomer = window.guardAsyncAction((uid) => `admin-reject-customer:${uid}`, window.rejectCustomer);
window.deleteApprovedCustomer = window.guardAsyncAction((uid) => `admin-delete-customer:${uid}`, window.deleteApprovedCustomer);
window.restoreCustomer = window.guardAsyncAction((uid) => `admin-restore-customer:${uid}`, window.restoreCustomer);
