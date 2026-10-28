import { loadTeamProfileView } from "./team-profile.js";
import { initStaffDeliveryManagement } from "./delivery-management.js";
import { auth, db } from "./firebase-init.js";
import { collection, getDocs, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { apiConfirmCODPayment, apiCompletePickupOrder, apiCreateWalkInOrder, apiCompleteWalkInOrder } from "./api.js";

let allOrders = [];
let activeFilter = 'all';

export async function initStaffDashboard() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '<a href="#" class="nav-link active" data-target="orders"><span class="nav-icon" aria-hidden="true">▤</span><span>Order Processing</span></a><a href="#" class="nav-link" data-target="delivery-management"><span class="nav-icon" aria-hidden="true">⇄</span><span>Delivery Management</span></a><a href="#" class="nav-link" data-target="profile"><span class="nav-icon" aria-hidden="true">♙</span><span>My Profile</span></a>';
  nav.addEventListener('click', e => {
    const link = e.target.closest('.nav-link[data-target]');
    if (!link || !nav.contains(link)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = link.dataset.target;
    setStaffNavActive(target);
    if (target === 'profile') loadTeamProfileView('Staff');
    else if (target === 'delivery-management') initStaffDeliveryManagement();
    else if (target === 'orders') loadStaffOrdersView();
  });
  await loadStaffOrdersView();
  installStaffPullToRefresh();
}

function installStaffPullToRefresh() {
  const content = document.getElementById('app-content');
  if (!content || content.dataset.pullRefreshBound === 'true') return;
  content.dataset.pullRefreshBound = 'true';
  let startY = 0, startX = 0;
  content.addEventListener('touchstart', e => {
    if (window.scrollY > 4 || document.querySelector('.modal-overlay')) { startY = 0; return; }
    const t = e.touches?.[0]; startY = t?.clientY || 0; startX = t?.clientX || 0;
  }, { passive: true });
  content.addEventListener('touchend', e => {
    const t = e.changedTouches?.[0];
    if (!startY || !t || t.clientY - startY < 85 || Math.abs(t.clientX - startX) > 70 || window.scrollY > 4 || document.querySelector('.modal-overlay')) { startY = 0; return; }
    startY = 0;
    const button = document.getElementById('staff-refresh');
    if (button && !button.disabled) { button.disabled = true; button.textContent = 'Refreshing…'; loadStaffOrdersView().finally(() => { const current = document.getElementById('staff-refresh'); if (current) { current.disabled = false; current.textContent = '↻ Refresh'; } }); }
  }, { passive: true });
}

function setStaffNavActive(target) {
  document.querySelectorAll('#sidebar-nav .nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.target === target);
  });
}

async function loadStaffOrdersView() {
  activeFilter = 'all';
  const content = document.getElementById('app-content');
  content.innerHTML = `<section class="workflow-page staff-queue-page">
    <header class="workflow-heading"><div><h2>Staff Order Queue</h2><p>Process the oldest active order first. Status, payment, and next steps are shown clearly.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-primary" id="staff-new-walkin">+ Walk-in Order</button><button type="button" class="btn-secondary" id="staff-refresh">↻ Refresh</button></div></header>
    <div class="staff-today-heading">Today's Active Orders</div>
    <div class="workflow-stats staff-queue-stats">
      <button type="button" class="workflow-stat staff-stat-filter active" data-filter="all" aria-pressed="true"><span>Active Orders</span><strong id="staff-stat-all">—</strong><small>Today's active orders</small></button>
      <button type="button" class="workflow-stat staff-stat-priority staff-stat-filter" data-filter="ready" aria-pressed="false"><span>Ready</span><strong id="staff-stat-ready">—</strong><small>Pickup and delivery</small></button>
      <button type="button" class="workflow-stat staff-stat-unpaid staff-stat-filter" data-filter="unpaid" aria-pressed="false"><span>Payment Attention</span><strong id="staff-stat-unpaid">—</strong><small>Unpaid / pending verification</small></button>
      <button type="button" class="workflow-stat staff-stat-filter" data-filter="history" aria-pressed="false"><span>Order History</span><strong id="staff-stat-new">—</strong><small>Completed, failed, or cancelled</small></button>
    </div>
    <div class="staff-queue-controls">
      <label class="workflow-search staff-queue-search"><span class="staff-search-icon search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><span class="sr-only">Search orders</span><input id="staff-order-search" type="search" placeholder="Search customer, order ID, address, contact, or date..." aria-label="Search orders by customer, order ID, address, contact, or date"></label>
      <p class="staff-search-date-hint" id="staff-search-date-hint">Date search examples: <strong>2026-10-22</strong>, <strong>10/22/2026</strong>, or <strong>Oct 22, 2026</strong>.</p>

    </div>
    <div id="staff-orders-list" class="workflow-list staff-queue-grid" aria-live="polite"><div class="workflow-empty">Loading orders…</div></div>
    <p class="workflow-note">COD: confirm only after cash is received. GCash payments must be verified by Admin before pickup completion.</p>
  </section>`;
  document.getElementById('staff-refresh').addEventListener('click', loadStaffOrdersView);
  document.getElementById('staff-new-walkin').addEventListener('click', openWalkInOrderForm);
  const staffDateHint=document.getElementById('staff-search-date-hint');
  if(staffDateHint){
    const now=new Date();
    const iso=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const us=`${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
    const long=now.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    staffDateHint.innerHTML=`Date search examples: <strong>${iso}</strong>, <strong>${us}</strong>, or <strong>${esc(long)}</strong>.`;
  }
  document.getElementById('staff-order-search').addEventListener('input', renderOrders);
  document.querySelectorAll('#app-content .staff-stat-filter[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll('#app-content .staff-stat-filter[data-filter]').forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
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

function staffLocalDateKey(value) {
  const date = value?.toDate ? value.toDate() : (value instanceof Date ? value : (value ? new Date(value) : null));
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function updateStaffStats() {
  const today = staffLocalDateKey(new Date());
  const terminal = o => ['completed','failed','cancelled'].includes(String(o.deliveryStatus || 'pending').toLowerCase());
  const active = allOrders.filter(o => !terminal(o));
  const todayActive = active.filter(o => staffLocalDateKey(o.createdAt) === today);
  const ready = active.filter(o => ['ready_for_pickup','ready_for_dispatch'].includes(String(o.deliveryStatus || '').toLowerCase()));
  const unpaid = active.filter(o => !isPaymentSettled(o));
  const history = allOrders.filter(terminal);
  const set = (id,value) => { const el=document.getElementById(id); if(el) el.textContent=value; };
  set('staff-stat-all',todayActive.length);
  set('staff-stat-ready',ready.length);
  set('staff-stat-unpaid',unpaid.length);
  set('staff-stat-new',history.length);
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
    const status = String(o.deliveryStatus || 'pending').toLowerCase();
    const active = !['completed','failed','cancelled'].includes(status);
    const paid = isPaymentSettled(o);
    const matchesFilter = filter === 'all' ? active && staffLocalDateKey(o.createdAt) === staffLocalDateKey(new Date()) :
      filter === 'ready' ? active && ['ready_for_pickup','ready_for_dispatch'].includes(status) :
      filter === 'unpaid' ? active && !paid :
      filter === 'history' ? ['completed','failed','cancelled'].includes(status) : active;
    const orderDateRaw = o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt instanceof Date ? o.createdAt : (o.createdAt ? new Date(o.createdAt) : null));
    const orderDate = orderDateRaw && !Number.isNaN(orderDateRaw.getTime()) ? [
      orderDateRaw.getFullYear(),
      `${orderDateRaw.getFullYear()}-${String(orderDateRaw.getMonth()+1).padStart(2,'0')}-${String(orderDateRaw.getDate()).padStart(2,'0')}`,
      orderDateRaw.toLocaleDateString('en-US'),
      orderDateRaw.toLocaleDateString('en-GB'),
      orderDateRaw.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
      orderDateRaw.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})
    ].join(' ') : '';
    const searchable = `${o.id} ${o.customerName||''} ${o.deliveryAddress||''} ${o.contactNumber||''} ${orderDate}`.toLowerCase();
    return matchesFilter && searchable.includes(q);
  }).sort((a,b) => {
    const rank=queueRank(a)-queueRank(b);
    return rank || millis(a.createdAt)-millis(b.createdAt);
  });
  const titleMap={all:"Today's active orders",ready:'Ready for pickup and delivery',unpaid:'Orders needing payment attention',history:'Order history'};
  const title=document.getElementById('staff-list-title'); if(title) title.textContent=titleMap[filter]||'Orders to process';
  if (!filtered.length) { target.innerHTML = `<div class="workflow-empty"><strong>${filter==='all'?'No active orders for today':filter==='history'?'No order history':'No matching orders'}</strong>${filter==='all'?'Today’s active orders will appear here when received.':filter==='history'?'Completed, failed, and cancelled orders will appear here.':'Try another filter or search term.'}</div>`; return; }
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
        <div class="staff-order-summary"><span>${esc(o.deliveryAddress || (isPickup?'Pickup at station':'Address not provided'))}</span><small>${Array.isArray(o.items)?o.items.reduce((sum,item)=>sum+Number(item.quantity||0),0):0} items</small></div>
        <div class="staff-order-badges"><span class="staff-status-pill ${statusClass}">${esc(statusLabel(status))}</span><span class="staff-status-pill ${paymentClass}">${esc(paymentLabel)}</span><span class="staff-type-pill">${isPickup?'Pickup':'Delivery'}</span></div>
        <div class="staff-order-details" id="staff-details-${id}" hidden>
          <div class="workflow-order-grid"><div class="workflow-detail"><span>Order items</span><strong>${items}</strong></div><div class="workflow-detail"><span>Next action</span><strong class="staff-next-action">${esc(nextLabel)}</strong></div><div class="workflow-detail"><span>Contact</span><strong>${esc(o.contactNumber || 'Not provided')}</strong></div><div class="workflow-detail"><span>${isPickup?'Pickup':'Delivery'} details</span><strong>${esc(o.deliveryAddress || (isPickup?'Pickup at station':'Address not provided'))}</strong></div>${!isPickup?`<div class="workflow-detail"><span>Driver</span><strong>${o.assignedDriverId ? 'Assigned' : 'Not assigned'}</strong></div>`:''}${Array.isArray(o.deliveryAttemptHistory)&&o.deliveryAttemptHistory.length?`<div class="workflow-detail"><span>Delivery attempts (${o.deliveryAttemptHistory.length})</span><strong>${o.deliveryAttemptHistory.map((attempt,index)=>`${index+1}. ${esc(attempt.reason||'Reason not recorded')} · ${esc(attempt.failedAt||'Date unavailable')}`).join(' | ')}</strong></div>`:''}</div>
          <div class="workflow-order-actions">${next.length?`<select aria-label="Update order ${id.slice(0,8)} status" data-status-for="${id}"><option value="">Choose next step…</option>${next.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>`:''}${isPickup&&status==='ready_for_pickup'&&o.isWalkIn&&paid?`<button type="button" class="btn-primary" data-walkin-complete="${id}">Confirm Handover</button>`:''}${isPickup&&status==='ready_for_pickup'&&!o.isWalkIn?`<button type="button" class="btn-primary" data-pickup-complete="${id}">Confirm Picked Up${method==='cod'&&!paid?' & Paid':''}</button>`:''}${method==='cod'&&!paid&&isActive&&((!isPickup&&status==='out_for_delivery')||(isPickup&&o.isWalkIn&&status==='ready_for_pickup'))?`<button type="button" class="btn-primary" data-cod-order="${id}">Confirm cash received</button>`:''}</div>
        </div>
        <div class="staff-order-card-footer"><span class="staff-next-action-summary">${esc(nextLabel)}</span><button type="button" class="btn-secondary staff-details-toggle" data-toggle-staff-details="${id}" aria-expanded="false">Show full details</button></div>
      </div></article>`;
  }).join('');
  target.querySelectorAll('[data-toggle-staff-details]').forEach(btn => btn.addEventListener('click', () => {
    const panel=document.getElementById(`staff-details-${btn.dataset.toggleStaffDetails}`);
    if(!panel) return;
    const show=panel.hidden;
    panel.hidden=!show;
    btn.textContent=show?'Hide full details':'Show full details';
    btn.setAttribute('aria-expanded',String(show));
  }));
  target.querySelectorAll('[data-status-for]').forEach(el => el.addEventListener('change', () => { const id=el.dataset.statusFor, status=el.value; if(status) { el.value=''; updateOrderStatus(id,status); } }));
  target.querySelectorAll('[data-cod-order]').forEach(btn => btn.addEventListener('click', () => confirmStaffCOD(btn.dataset.codOrder)));
  target.querySelectorAll('[data-pickup-complete]').forEach(btn => btn.addEventListener('click', () => completeStaffPickup(btn.dataset.pickupComplete)));
  target.querySelectorAll('[data-walkin-complete]').forEach(btn => btn.addEventListener('click', () => completeWalkInHandover(btn.dataset.walkinComplete)));
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
  if (button) { button.disabled = true; button.dataset.processing = 'true'; button.textContent = 'Completing…'; }
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
  const button = document.querySelector(`[data-cod-order="${CSS.escape(orderId)}"]`);
  if (!button || button.disabled) return;
  if (!await window.showConfirmModal({title:'Confirm cash received?',message:'Only continue if the customer has physically paid the exact amount in cash.',confirmText:'Confirm payment',cancelText:'Cancel'})) return;
  button.disabled = true; button.dataset.processing = 'true'; button.textContent = 'Recording…';
  try {
    const result = await apiConfirmCODPayment(orderId);
    const order = allOrders.find(item => item.id === orderId);
    if (order) { order.paymentStatus = 'paid'; order.updatedAt = new Date(); }
    updateStaffStats(); renderOrders();
    window.showToast(`Cash payment recorded. Receipt: ${result.receiptNumber}. You can now confirm handover.`, 'success');
  } catch(err) {
    // Reload authoritative data before allowing another attempt; the first request may have committed.
    await loadStaffOrdersView();
    window.showToast('Could not confirm cash payment: '+err.message,'error');
  }
}
function millis(v){return v?.toMillis?v.toMillis():v?.seconds?v.seconds*1000:0;}
function fmtDate(v){const n=millis(v);return n?new Date(n).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';}
function statusLabel(v){const key=String(v||'unknown').toLowerCase();const labels={pending:'Pending',accepted:'Confirmed',preparing:'Processing',processing:'Processing',ready_for_pickup:'Ready for Pickup',ready_for_dispatch:'Ready for Dispatch',out_for_delivery:'Out for Delivery',delivered:'Delivered',completed:'Completed',failed:'Delivery Failed',cancelled:'Cancelled',unpaid:'Unpaid',pending_verification:'Verifying Payment',paid:'Paid',rejected:'Payment Rejected',refund_pending:'Refund Pending',refunded:'Refunded',cod:'Cash on Delivery',online:'GCash',gcash:'GCash'};return labels[key]||key.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}


async function openWalkInOrderForm() {
  let products;
  try { const snap = await getDocs(collection(db, 'products')); products = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(p => p.active !== false && Number(p.price) > 0); }
  catch (e) { window.showToast('Could not load product catalog: ' + e.message, 'error'); return; }
  if (!products.length) { window.showToast('No active products are available.', 'error'); return; }
  const options = products.map(p => `<option value="${esc(p.id)}" data-name="${esc(p.name||'Product')}" data-price="${Number(p.price)}">${esc(p.name||'Product')} — ₱${Number(p.price).toFixed(2)}</option>`).join('');
  const modal = document.createElement('div'); modal.className='modal-overlay'; modal.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,35,45,.58);'; modal.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="walkin-title" style="box-sizing:border-box;background:var(--surface,#fff);color:var(--text,#193b43);border:1px solid var(--border,#d7e6e9);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.22);max-width:620px;width:100%;max-height:90vh;overflow:auto;padding:0"><header class="modal-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border,#d7e6e9)"><h2 id="walkin-title" style="margin:0;font-size:1.25rem">Create Walk-in Order</h2><button type="button" class="modal-close" data-close aria-label="Close" style="border:0;border-radius:8px;background:var(--surface-secondary,#f1f6f7);padding:8px 12px;cursor:pointer">×</button></header><div class="modal-body" style="padding:18px 20px"><p>Anonymous in-station pickup. No customer account or personal details required.</p><div id="walkin-lines" style="display:grid;gap:10px"><div class="walkin-line" style="display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:8px"><label>Product<select class="walkin-product" style="width:100%">${options}</select></label><label>Qty<input class="walkin-qty" type="number" min="1" max="100" value="1" style="width:100%"></label></div></div><p class="walkin-single-product-note" style="margin:10px 0 0;color:var(--text-secondary,#667);font-size:13px">One product type per walk-in order. Adjust the quantity for multiple gallons.</p><div style="margin:18px 0;padding:14px;background:var(--surface-secondary,#f4f8f8);border-radius:10px;display:flex;justify-content:space-between;gap:10px"><strong>Total</strong><strong id="walkin-total">₱0.00</strong></div><fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:8px">Payment method</legend><label style="margin-right:18px"><input type="radio" name="walkin-payment" value="cod" checked> Cash</label><label><input type="radio" name="walkin-payment" value="online"> GCash</label></fieldset><p style="font-size:13px;color:var(--text-secondary,#667);margin-top:12px">Cash: confirm after receiving cash. GCash: order stays pending verification until Admin approves it. Handover is a separate action.</p></div><footer class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;padding:16px 20px;border-top:1px solid var(--border,#d7e6e9)"><button type="button" class="btn-secondary" data-close>Cancel</button><button type="button" class="btn-primary" id="walkin-create">Create Order</button></footer></section>`;
  document.body.appendChild(modal); const lines=modal.querySelector('#walkin-lines');
  const updateTotal=()=>{let total=0;lines.querySelectorAll('.walkin-line').forEach(row=>{const sel=row.querySelector('.walkin-product'),qty=Math.max(1,Math.min(100,Number(row.querySelector('.walkin-qty').value)||1));total+=Number(sel.selectedOptions[0]?.dataset.price||0)*qty;});modal.querySelector('#walkin-total').textContent='₱'+total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});};
  const bind=row=>{row.querySelectorAll('select,input').forEach(el=>el.addEventListener('input',updateTotal));}; bind(lines.firstElementChild); updateTotal();
  modal.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>modal.remove())); modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
  modal.querySelector('#walkin-create').addEventListener('click',async btn=>{const button=modal.querySelector('#walkin-create');if(button.disabled)return;button.disabled=true;button.textContent='Creating…';try{const items=[...lines.querySelectorAll('.walkin-line')].map(row=>{const sel=row.querySelector('.walkin-product'),opt=sel.selectedOptions[0];return {productId:sel.value,name:opt.dataset.name,unitPrice:Number(opt.dataset.price),quantity:Number(row.querySelector('.walkin-qty').value)};});const method=modal.querySelector('input[name="walkin-payment"]:checked').value;const result=await apiCreateWalkInOrder(items,method);window.showToast(`Walk-in order created: ${result.orderId}. Total ₱${result.totalAmount.toFixed(2)}. ${method==='online'?'Awaiting Admin GCash verification.':'Confirm cash received to issue the official receipt.'}`,'success');modal.remove();await loadStaffOrdersView();}catch(e){window.showToast('Could not create walk-in order: '+e.message,'error');button.disabled=false;button.textContent='Create Order';}});
}

async function completeWalkInHandover(orderId) {
  const button = document.querySelector(`[data-walkin-complete="${CSS.escape(orderId)}"]`);
  if (!button || button.disabled) return;
  if (!await window.showConfirmModal({title:'Confirm handover?',message:'Confirm only after the water has physically been handed to the walk-in customer. Payment must already be confirmed.',confirmText:'Confirm Handover',cancelText:'Cancel'})) return;
  button.disabled = true;
  button.textContent = 'Completing…';
  try {
    await apiCompleteWalkInOrder(orderId);
    const order = allOrders.find(item => item.id === orderId);
    if (order) { order.deliveryStatus = 'completed'; order.completedAt = new Date(); }
    updateStaffStats();
    renderOrders();
    window.showToast('Walk-in order marked completed.','success');
  } catch(e) {
    window.showToast('Could not complete walk-in order: '+e.message,'error');
    button.disabled = false;
    button.textContent = 'Confirm Handover';
  }
}


// Guard Staff order-state and payment actions until their full async workflow completes.
updateOrderStatus = window.guardAsyncAction((orderId, status) => `staff-status:${orderId}:${status}`, updateOrderStatus);
completeStaffPickup = window.guardAsyncAction((orderId) => `staff-pickup:${orderId}`, completeStaffPickup);
confirmStaffCOD = window.guardAsyncAction((orderId) => `staff-cod:${orderId}`, confirmStaffCOD);
completeWalkInHandover = window.guardAsyncAction((orderId) => `staff-walkin-handover:${orderId}`, completeWalkInHandover);
