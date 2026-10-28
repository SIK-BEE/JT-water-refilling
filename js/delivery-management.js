import { auth, db } from "./firebase-init.js";
import { collection, getDocs, query, where, doc, getDoc, updateDoc, serverTimestamp, deleteField } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { apiAssignDriver } from "./api.js";

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

export async function initStaffDeliveryManagement() {
    await loadDeliveryAssignments();
}

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
        let ordersSnap;
        try {
            ordersSnap = await getDocs(collection(db, 'orders'));
        } catch (error) {
            throw new Error('Orders query denied. Check the published Firestore rules for Staff order reads. ' + error.message);
        }
        let usersSnap;
        try {
            usersSnap = await getDocs(query(collection(db, 'users'), where('role', '==', 'driver')));
        } catch (error) {
            throw new Error('Driver directory query denied. Publish the updated users get/list rules from firestore.rules, then sign out and sign back in. ' + error.message);
        }

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
const statusLabel = status => ({pending:'Pending',accepted:'Confirmed',preparing:'Processing',processing:'Processing',ready_for_pickup:'Ready for Pickup',ready_for_dispatch:'Ready for Dispatch',out_for_delivery:'Out for Delivery',delivered:'Delivered',completed:'Completed',failed:'Delivery Failed',cancelled:'Cancelled',unpaid:'Unpaid',pending_verification:'Verifying Payment',paid:'Paid',rejected:'Payment Rejected',refund_pending:'Refund Pending',refunded:'Refunded',cod:'Cash on Delivery',online:'GCash',gcash:'GCash'}[String(status||'pending').toLowerCase()] || String(status||'pending').replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()));
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
        target.innerHTML = `<div class="delivery-empty"><strong>Could not load delivery assignments</strong><p class="error-msg">${esc(error.message)}</p><button type="button" class="btn-secondary" id="delivery-retry-load">Try Again</button></div>`;
        document.getElementById('delivery-retry-load')?.addEventListener('click', loadDeliveryAssignments);
        document.querySelectorAll('[data-delivery-tab]').forEach(tab => tab.addEventListener('click', () => {
            deliveryTab = tab.dataset.deliveryTab;
            document.querySelectorAll('[data-delivery-tab]').forEach(item => {
                const active = item === tab;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', String(active));
            });
            target.innerHTML = `<div class="delivery-empty"><strong>${deliveryTab === 'failed' ? 'Failed Deliveries' : 'Pending Deliveries'}</strong><p>Records are unavailable until the Firestore permission issue is resolved.</p><button type="button" class="btn-secondary" id="delivery-retry-load">Try Again</button></div>`;
            document.getElementById('delivery-retry-load')?.addEventListener('click', loadDeliveryAssignments);
        }));
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

