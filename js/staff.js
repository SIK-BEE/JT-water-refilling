import { loadTeamProfileView } from "./team-profile.js";
import { auth, db } from "./firebase-init.js";
import { collection, getDocs, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { apiConfirmCODPayment, apiCompletePickupOrder } from "./api.js";

let allOrders = [];
let activeFilter = 'all';

export async function initStaffDashboard() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '<a href="#" class="nav-link active" data-target="orders"><span class="nav-icon" aria-hidden="true">▤</span><span>Order Processing</span></a><a href="#" class="nav-link" data-target="profile"><span class="nav-icon" aria-hidden="true">♙</span><span>My Profile</span></a>';
  nav.addEventListener('click', e => {
    const link = e.target.closest('.nav-link[data-target]');
    if (!link || !nav.contains(link)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = link.dataset.target;
    setStaffNavActive(target);
    if (target === 'profile') loadTeamProfileView('Staff');
    else if (target === 'orders') loadStaffOrdersView();
  });
  await loadStaffOrdersView();
}


function setStaffNavActive(target) {
  document.querySelectorAll('#sidebar-nav .nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.target === target);
  });
}

async function loadStaffOrdersView() {
  const content = document.getElementById('app-content');
  content.innerHTML = `<section class="workflow-page staff-queue-page">
    <header class="workflow-heading"><div><h2>Staff Order Queue</h2><p>Process the oldest active order first. Status, payment, and next steps are shown clearly.</p></div><button type="button" class="btn-secondary" id="staff-refresh">↻ Refresh</button></header>
    <div class="workflow-stats staff-queue-stats">
      <article class="workflow-stat"><span>Active Orders</span><strong id="staff-stat-all">—</strong><small>Not yet completed</small></article>
      <article class="workflow-stat staff-stat-priority"><span>Ready for Pickup</span><strong id="staff-stat-ready">—</strong><small>Waiting for customer</small></article>
      <article class="workflow-stat staff-stat-unpaid"><span>Payment Attention</span><strong id="staff-stat-unpaid">—</strong><small>Unpaid / pending verification</small></article>
      <article class="workflow-stat"><span>Needs Preparation</span><strong id="staff-stat-new">—</strong><small>Pending, accepted, or preparing</small></article>
    </div>
    <div class="staff-queue-priority-note"><span class="staff-priority-dot"></span><div><strong>Priority guide</strong><p>Release ready orders first, then process the oldest waiting order. Payment issues remain highlighted.</p></div></div>
    <div class="staff-queue-controls">
      <label class="workflow-search staff-queue-search"><span class="sr-only">Search orders</span><input id="staff-order-search" type="search" placeholder="Search customer, order ID, contact…"></label>
      <div class="workflow-filter staff-queue-filters" role="group" aria-label="Filter orders">
        <button type="button" class="active" data-filter="all">Active queue</button><button type="button" data-filter="ready">Ready</button><button type="button" data-filter="unpaid">Payment attention</button><button type="button" data-filter="pickup">Pickup</button><button type="button" data-filter="delivery">Delivery</button><button type="button" data-filter="completed">Completed</button>
      </div>
    </div>
    <div class="staff-queue-list-heading"><h3 id="staff-list-title">Orders to process</h3><span id="staff-list-count">Loading…</span></div>
    <div id="staff-orders-list" class="workflow-list staff-queue-grid" aria-live="polite"><div class="workflow-empty">Loading orders…</div></div>
    <p class="workflow-note">COD: confirm only after cash is received. GCash payments must be verified by Admin before pickup completion.</p>
  </section>`;
  document.getElementById('staff-refresh').addEventListener('click', loadStaffOrdersView);
  document.getElementById('staff-order-search').addEventListener('input', renderOrders);
  document.querySelectorAll('#app-content [data-filter]').forEach(btn => btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll('#app-content [data-filter]').forEach(b => b.classList.toggle('active', b === btn));
    renderOrders();
  }));
  const target = document.getElementById('staff-orders-list');
  try {
    const snap = await getDocs(collection(db, 'orders'));
    allOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateStaffStats();
    renderOrders();
  } catch (err) { target.innerHTML = `<div class="workflow-empty"><strong>Orders could not be loaded</strong>${esc(err.message)}</div>`; }
}

function updateStaffStats() {
  const active = allOrders.filter(o => !['completed','failed','cancelled'].includes(String(o.deliveryStatus || 'pending')));
  const ready = active.filter(o => o.deliveryStatus === 'ready_for_pickup');
  const unpaid = active.filter(o => !isPaymentSettled(o));
  const prep = active.filter(o => ['pending','accepted','preparing'].includes(String(o.deliveryStatus || 'pending')));
  const set = (id,value) => { const el=document.getElementById(id); if(el) el.textContent=value; };
  set('staff-stat-all',active.length); set('staff-stat-ready',ready.length); set('staff-stat-unpaid',unpaid.length); set('staff-stat-new',prep.length);
}
function isPaymentSettled(o) {
  // Treat an order as paid only when the canonical order paymentStatus says paid.
  // GCash proof submission/approval metadata alone must not hide a pending payment.
  return String(o.paymentStatus || '').toLowerCase() === 'paid';
}
function queueRank(o) {
  const status=String(o.deliveryStatus||'pending');
  if(status==='ready_for_pickup') return 0;
  if(['pending','accepted','preparing'].includes(status)) return 1;
  if(!['completed','failed','cancelled'].includes(status)) return 2;
  return 3;
}
function renderOrders() {
  const target = document.getElementById('staff-orders-list'); if (!target) return;
  const q = (document.getElementById('staff-order-search')?.value || '').trim().toLowerCase();
  const filter = activeFilter || 'all';
  const filtered = allOrders.filter(o => {
    const status = String(o.deliveryStatus || 'pending');
    const active = !['completed','failed','cancelled'].includes(status);
    const paid = isPaymentSettled(o);
    const matchesFilter = filter === 'all' ? active :
      filter === 'ready' ? status === 'ready_for_pickup' :
      filter === 'unpaid' ? active && !paid :
      filter === 'pickup' ? active && String(o.type||'pickup').toLowerCase() !== 'delivery' :
      filter === 'delivery' ? active && String(o.type||'').toLowerCase() === 'delivery' :
      filter === 'completed' ? ['completed','failed','cancelled'].includes(status) : active;
    const searchable = `${o.id} ${o.customerName||''} ${o.deliveryAddress||''} ${o.contactNumber||''}`.toLowerCase();
    return matchesFilter && searchable.includes(q);
  }).sort((a,b) => {
    const rank=queueRank(a)-queueRank(b);
    return rank || millis(a.createdAt)-millis(b.createdAt);
  });
  const titleMap={all:'Orders to process',ready:'Ready for pickup / release',unpaid:'Orders needing payment attention',pickup:'Pickup queue',delivery:'Delivery queue',completed:'Completed and closed orders'};
  const title=document.getElementById('staff-list-title'); if(title) title.textContent=titleMap[filter]||'Orders to process';
  const count=document.getElementById('staff-list-count'); if(count) count.textContent=`${filtered.length} order${filtered.length===1?'':'s'}`;
  if (!filtered.length) { target.innerHTML = `<div class="workflow-empty"><strong>${filter==='all'?'Queue is clear':'No matching orders'}</strong>${filter==='all'?'New orders will appear here when received.':'Try another filter or search term.'}</div>`; return; }
  target.innerHTML = filtered.map((o,index) => {
    const id = esc(o.id), status = String(o.deliveryStatus || 'pending'), method = String(o.paymentMethod || 'cod').toLowerCase(), paid = isPaymentSettled(o);
    const isActive=!['completed','failed','cancelled'].includes(status);
    const isPickup=String(o.type||'pickup').toLowerCase()!=='delivery';
    const items = Array.isArray(o.items) ? o.items.map(i => `${esc(i.name || 'Item')} × ${Number(i.quantity || 0)}`).join(', ') : 'Order items unavailable';
    const date = fmtDate(o.createdAt);
    const readyStatus = isPickup ? 'ready_for_pickup' : 'ready_for_dispatch';
    const readyAction = isPickup ? 'Mark ready for pickup' : 'Mark ready for dispatch';
    const next = status === 'pending' ? [['accepted','Accept order'],['preparing','Start preparing'],[readyStatus,readyAction]] : status === 'accepted' ? [['preparing','Start preparing'],[readyStatus,readyAction]] : status === 'preparing' ? [[readyStatus,readyAction]] : [];
    const nextLabel=status==='ready_for_pickup'?'Confirm customer pickup':status==='ready_for_dispatch'?'Waiting for driver assignment':status==='pending'?'Review and accept':status==='accepted'?'Start preparation':status==='preparing'?'Finish preparation':status==='out_for_delivery'?'Out for delivery':status==='completed'?'Completed':status==='failed'?'Failed / review':statusLabel(status);
    const paymentLabel=paid?'Paid':method==='gcash'?'GCash · Needs verification':`Unpaid · ${statusLabel(method)}`;
    const statusClass=(status==='ready_for_pickup'||status==='ready_for_dispatch')?'ready':status==='preparing'||status==='out_for_delivery'?'progress':status==='completed'?'done':(['failed','cancelled'].includes(status)?'issue':'waiting');
    const paymentClass=paid?'paid':'unpaid';
    const queueNo=String(index+1).padStart(2,'0');
    return `<article class="workflow-order staff-queue-order ${(status==='ready_for_pickup'||status==='ready_for_dispatch')?'is-ready':''} ${!paid&&isActive?'has-payment-alert':''}">
      <div class="staff-queue-number" aria-label="Queue position ${index+1}">${filter==='completed'?'✓':queueNo}</div>
      <div class="staff-queue-main">
        <div class="workflow-order-head"><div class="workflow-order-title"><strong>${esc(o.customerName || 'Customer')}</strong><small>Order #${id.slice(0,8)} · ${date}</small></div><div class="workflow-order-total">₱${Number(o.totalAmount||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
        <div class="staff-order-badges"><span class="staff-status-pill ${statusClass}">${esc(statusLabel(status))}</span><span class="staff-status-pill ${paymentClass}">${esc(paymentLabel)}</span><span class="staff-type-pill">${isPickup?'Pickup':'Delivery'}</span></div>
        <div class="workflow-order-grid"><div class="workflow-detail"><span>Order items</span><strong>${items}</strong></div><div class="workflow-detail"><span>Next action</span><strong class="staff-next-action">${esc(nextLabel)}</strong></div><div class="workflow-detail"><span>Contact</span><strong>${esc(o.contactNumber || 'Not provided')}</strong></div><div class="workflow-detail"><span>${isPickup?'Pickup':'Delivery'} details</span><strong>${esc(o.deliveryAddress || (isPickup?'Pickup at station':'Address not provided'))}</strong></div>${!isPickup?`<div class="workflow-detail"><span>Driver</span><strong>${o.assignedDriverId ? 'Assigned' : 'Not assigned'}</strong></div>`:''}</div>
        <div class="workflow-order-actions">${next.length?`<select aria-label="Update order ${id.slice(0,8)} status" data-status-for="${id}"><option value="">Choose next step…</option>${next.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>`:''}${isPickup&&status==='ready_for_pickup'?`<button type="button" class="btn-primary" data-pickup-complete="${id}">Confirm Picked Up${method==='cod'&&!paid?' & Paid':''}</button>`:''}${method==='cod'&&!paid&&!(isPickup&&status==='ready_for_pickup')&&isActive?`<button type="button" class="btn-primary" data-cod-order="${id}">Confirm cash received</button>`:''}</div>
      </div></article>`;
  }).join('');
  target.querySelectorAll('[data-status-for]').forEach(el => el.addEventListener('change', () => { const id=el.dataset.statusFor, status=el.value; if(status) { el.value=''; updateOrderStatus(id,status); } }));
  target.querySelectorAll('[data-cod-order]').forEach(btn => btn.addEventListener('click', () => confirmStaffCOD(btn.dataset.codOrder)));
  target.querySelectorAll('[data-pickup-complete]').forEach(btn => btn.addEventListener('click', () => completeStaffPickup(btn.dataset.pickupComplete)));
}
async function updateOrderStatus(orderId, status) {
  const label = ({accepted:'accept this order',preparing:'start preparing this order',ready_for_pickup:'mark this pickup order ready',ready_for_dispatch:'mark this delivery order ready for dispatch'})[status] || 'update this order';
  if (!await window.showConfirmModal({ title:'Confirm status update', message:`Are you sure you want to ${label}?`, confirmText:'Confirm', cancelText:'Cancel' })) return;
  try { await updateDoc(doc(db,'orders',orderId), { deliveryStatus:status, updatedAt:serverTimestamp() }); window.showToast('Order status updated.','success'); await loadStaffOrdersView(); }
  catch(err) { window.showToast('Could not update order: '+err.message,'error'); await loadStaffOrdersView(); }
}
async function completeStaffPickup(orderId) {
  const button = document.querySelector(`[data-pickup-complete="${CSS.escape(orderId)}"]`);
  if (button?.disabled) return;
  if (!await window.showConfirmModal({
    title:'Confirm customer pickup?',
    message:'Confirm only after the customer has physically received the order. For COD, this will mark the order completed and paid and create the sale and official receipt. GCash orders must already be verified.',
    confirmText:'Confirm Picked Up',
    cancelText:'Cancel'
  })) return;
  if (button) { button.disabled = true; button.dataset.processing = 'true'; button.textContent = 'Processing…'; }
  try {
    const result = await apiCompletePickupOrder(orderId);
    window.showToast(result.receiptNumber ? `Pickup completed and payment recorded. Receipt: ${result.receiptNumber}` : 'Pickup completed. Verified payment and receipt retained.','success');
    await loadStaffOrdersView();
  } catch(err) {
    window.showToast('Could not complete pickup: '+err.message,'error');
    await loadStaffOrdersView();
  }
}
async function confirmStaffCOD(orderId) {
  if (!await window.showConfirmModal({title:'Confirm cash received?',message:'Only continue if the customer has physically paid the exact amount in cash.',confirmText:'Confirm payment',cancelText:'Cancel'})) return;
  try { const result=await apiConfirmCODPayment(orderId); window.showToast(`Cash payment recorded. Receipt: ${result.receiptNumber}`,'success'); await loadStaffOrdersView(); }
  catch(err) { window.showToast('Could not confirm cash payment: '+err.message,'error'); }
}
function millis(v){return v?.toMillis?v.toMillis():v?.seconds?v.seconds*1000:0;}
function fmtDate(v){const n=millis(v);return n?new Date(n).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';}
function statusLabel(v){return String(v||'unknown').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
