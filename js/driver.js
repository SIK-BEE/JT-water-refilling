import { loadTeamProfileView } from "./team-profile.js";
import { auth, db } from "./firebase-init.js";
import { collection, query, where, getDocs, getDoc, doc, updateDoc, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { apiConfirmCODPayment } from "./api.js";

let assignedOrders = [];
let activeFilter = 'pending';

export async function initDriverDashboard() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '<a href="#" class="nav-link active" data-target="deliveries"><span class="nav-icon" aria-hidden="true">⇄</span><span>Assigned Deliveries</span></a><a href="#" class="nav-link" data-target="profile"><span class="nav-icon" aria-hidden="true">♙</span><span>My Profile</span></a>';
  nav.addEventListener('click', e => {
    const link = e.target.closest('.nav-link[data-target]');
    if (!link || !nav.contains(link)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = link.dataset.target;
    setDriverNavActive(target);
    if (target === 'profile') loadTeamProfileView('Driver');
    else if (target === 'deliveries') loadDriverDeliveriesView();
  });
  await loadDriverDeliveriesView();
}

function setDriverNavActive(target) {
  document.querySelectorAll('#sidebar-nav .nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.target === target);
  });
}


async function loadDriverDeliveriesView() {
  const content=document.getElementById('app-content');
  content.innerHTML=`<section class="workflow-page driver-deliveries-page">
    <header class="workflow-heading"><div><h2>Assigned Deliveries</h2><p>Manage your assigned deliveries, update progress, and record cash collection.</p></div><button type="button" class="btn-secondary" id="driver-refresh">↻ Refresh</button></header>
    <div class="driver-today-heading">Assigned Delivery Queue</div>
    <div class="workflow-stats driver-delivery-tabs" role="group" aria-label="Filter assigned deliveries">
      <button type="button" class="workflow-stat driver-delivery-tab active" data-filter="pending" aria-pressed="true"><span>To Deliver</span><strong id="driver-tab-pending">—</strong></button>
      <button type="button" class="workflow-stat driver-delivery-tab" data-filter="done" aria-pressed="false"><span>Completed</span><strong id="driver-tab-done">—</strong></button>
      <button type="button" class="workflow-stat driver-delivery-tab" data-filter="failed" aria-pressed="false"><span>Failed</span><strong id="driver-tab-failed">—</strong></button>
      <button type="button" class="workflow-stat driver-delivery-tab" data-filter="history" aria-pressed="false"><span>History</span><strong id="driver-tab-all">—</strong></button>
    </div>
    <div class="workflow-toolbar driver-delivery-toolbar"><label class="workflow-search driver-search-field"><span class="driver-search-icon search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input id="driver-order-search" type="search" placeholder="Search customer, order ID, address, or date..." aria-label="Search by customer, order ID, address, phone, or date"></label></div>
    <p class="gcash-receipt-search-hint driver-delivery-search-hint" id="driver-delivery-search-hint">Date search examples: <strong>2026-10-22</strong>, <strong>10/22/2026</strong>, or <strong>Oct 22, 2026</strong>.</p>
    <div id="driver-deliveries-list" class="driver-deliveries-list" aria-live="polite"><div class="workflow-empty">Loading assigned deliveries…</div></div>
    <p class="workflow-note">For COD deliveries, confirm cash only after receiving the exact amount from the customer. Confirming cash also completes the delivery and creates the official sale and receipt.</p>
  </section>`;
  document.getElementById('driver-refresh').addEventListener('click',loadDriverDeliveriesView);
  const today = new Date();
  const isoToday = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const usToday = `${today.getMonth()+1}/${today.getDate()}/${today.getFullYear()}`;
  const longToday = today.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const hint = document.getElementById('driver-delivery-search-hint');
  if(hint) hint.innerHTML = `Date search examples: <strong>${isoToday}</strong>, <strong>${usToday}</strong>, or <strong>${esc(longToday)}</strong>.`;
  const searchInput = document.getElementById('driver-order-search');
  searchInput.addEventListener('input',renderDeliveries);
  document.querySelectorAll('.driver-delivery-tab[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{
    activeFilter=btn.dataset.filter;
    document.querySelectorAll('.driver-delivery-tab[data-filter]').forEach(b=>{const active=b===btn;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    renderDeliveries();
  }));
  const target=document.getElementById('driver-deliveries-list');
  try {
    const q=query(collection(db,'orders'),where('type','==','delivery'),where('assignedDriverId','==',auth.currentUser.uid));
    const snap=await getDocs(q);
    assignedOrders=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>millis(b.createdAt)-millis(a.createdAt));
    const localDateKey = value => {
      const date = value?.toDate ? value.toDate() : (value instanceof Date ? value : (value ? new Date(value) : null));
      if (!date || Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    };
    const todayKey = localDateKey(new Date());
    const todayCompleted = assignedOrders.filter(o => String(o.deliveryStatus||'').toLowerCase()==='completed' && localDateKey(o.completedAt)===todayKey);
    const activeOrders = assignedOrders.filter(o => !['completed','failed','cancelled'].includes(String(o.deliveryStatus||'pending').toLowerCase()));
    const failedOrders = assignedOrders.filter(o => String(o.deliveryStatus||'').toLowerCase()==='failed');
    document.getElementById('driver-tab-all').textContent=assignedOrders.length;
    document.getElementById('driver-tab-pending').textContent=activeOrders.length;
    document.getElementById('driver-tab-done').textContent=todayCompleted.length;
    document.getElementById('driver-tab-failed').textContent=failedOrders.length;
    renderDeliveries();
  } catch(err) { target.innerHTML=`<div class="workflow-empty"><strong>Deliveries could not be loaded</strong>${esc(err.message)}</div>`; }
}
function renderDeliveries(){
  const target=document.getElementById('driver-deliveries-list');if(!target)return;
  const q=(document.getElementById('driver-order-search')?.value||'').trim().toLowerCase();
  const filtered=assignedOrders.filter(o=>{
    const status=String(o.deliveryStatus||'pending').toLowerCase();
    const localDateKey = value => {
      const date = value?.toDate ? value.toDate() : (value instanceof Date ? value : (value ? new Date(value) : null));
      if (!date || Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    };
    const todayKey = localDateKey(new Date());
    const inFilter=activeFilter==='history'||
      (activeFilter==='pending'&&!['completed','failed','cancelled'].includes(status))||
      (activeFilter==='done'&&status==='completed'&&localDateKey(o.completedAt)===todayKey)||
      (activeFilter==='failed'&&status==='failed');
    const orderDateRaw = o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt instanceof Date ? o.createdAt : (o.createdAt ? new Date(o.createdAt) : null));
    const orderDate = orderDateRaw && !Number.isNaN(orderDateRaw.getTime()) ? [
      orderDateRaw.toISOString().slice(0,10),
      orderDateRaw.toLocaleDateString('en-US'),
      orderDateRaw.toLocaleDateString('en-GB'),
      orderDateRaw.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),
      orderDateRaw.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}),
      String(orderDateRaw.getFullYear()),
      `${String(orderDateRaw.getMonth()+1).padStart(2,'0')}/${String(orderDateRaw.getDate()).padStart(2,'0')}/${orderDateRaw.getFullYear()}`
    ].join(' ') : '';
    return inFilter&&`${o.id} ${o.customerName||''} ${o.deliveryAddress||''} ${o.contactNumber||''} ${orderDate}`.toLowerCase().includes(q);
  });
  if(!filtered.length){const emptyTitle=activeFilter==='failed'?'No failed deliveries':activeFilter==='done'?'No deliveries completed today':activeFilter==='pending'?'No deliveries to complete':'No delivery history';const emptyText=activeFilter==='failed'?'Failed attempts assigned to you will appear here.':activeFilter==='pending'?'Assigned deliveries ready for dispatch or currently in progress will appear here.':'Try another filter or search term.';target.innerHTML=`<div class="workflow-empty"><strong>${emptyTitle}</strong>${emptyText}</div>`;return;}
  target.innerHTML=filtered.map(o=>{
    const id=esc(o.id),status=String(o.deliveryStatus||'pending'),paid=o.paymentStatus==='paid',method=String(o.paymentMethod||'cod');
    const items=Array.isArray(o.items)?o.items.map(i=>`${esc(i.name||'Item')} × ${Number(i.quantity||0)}`).join(', '):'Order items unavailable';
    const itemCount=Array.isArray(o.items)?o.items.reduce((sum,i)=>sum+Number(i.quantity||0),0):0;
    const history=Array.isArray(o.deliveryAttemptHistory)?o.deliveryAttemptHistory:[];
    const attemptHistoryHtml=history.length?history.map((attempt,index)=>`<div>${index+1}. ${esc(attempt.reason||'No reason recorded')} <small>(${esc(formatAttemptDate(attempt.failedAt))})</small></div>`).join(''):'No failed attempts recorded.';
    const next=(status==='ready_for_dispatch')?[['out_for_delivery','Start delivery']]:status==='out_for_delivery'?[...(paid?[['completed','Mark delivered']]:[]),['failed','Failed attempt']]:[];
    const detailsId=`driver-details-${id}`;
    return `<article class="driver-delivery-card">
      <div class="driver-delivery-summary">
        <div class="driver-delivery-main"><strong>${esc(o.customerName||'Customer')}</strong><span class="driver-delivery-address">${esc(o.deliveryAddress||'No address provided')}</span><small>Order #${id.slice(0,8)} · ${fmtDate(o.createdAt)}</small></div>
        <div class="driver-delivery-total"><strong>₱${Number(o.totalAmount||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong><span>${itemCount} item${itemCount===1?'':'s'}</span></div>
      </div>
      <div class="driver-delivery-card-actions"><span class="driver-delivery-status status-${esc(status)}">${esc(statusLabel(status))}</span><button type="button" class="btn-secondary" data-toggle-details="${id}" aria-expanded="false" aria-controls="${detailsId}">Show full details</button></div>
      <div class="driver-delivery-full-details" id="${detailsId}" hidden>
        <div class="workflow-order-grid"><div class="workflow-detail"><span>Contact number</span><strong>${esc(o.contactNumber||'Not provided')}</strong></div><div class="workflow-detail"><span>Order items</span><strong>${items}</strong></div><div class="workflow-detail"><span>Delivery status</span><strong>${esc(statusLabel(status))}</strong></div><div class="workflow-detail"><span>Payment</span><strong>${esc(statusLabel(method))} · ${paid?'Paid':esc(statusLabel(o.paymentStatus||'unpaid'))}</strong></div><div class="workflow-detail"><span>Delivery attempts (${history.length})</span><strong class="driver-attempt-history">${attemptHistoryHtml}</strong></div><div class="workflow-detail"><span>Customer note</span><strong>${esc(o.note||'—')}</strong></div></div>
        <div class="workflow-order-actions">${next.length?`<select aria-label="Update delivery ${id.slice(0,8)} status" data-status-for="${id}"><option value="">Update delivery status…</option>${next.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>`:''}${status==='failed'?`<button type="button" class="btn-primary" data-retry-order="${id}">Retry Delivery</button>`:''}${method==='cod'&&!paid&&status==='out_for_delivery'?`<button type="button" class="btn-primary" data-cod-order="${id}">Confirm cash collected & mark delivered</button>`:''}</div>
      </div>
    </article>`;
  }).join('');
  target.querySelectorAll('[data-toggle-details]').forEach(btn=>btn.addEventListener('click',()=>{
    const panel=document.getElementById(`driver-details-${btn.dataset.toggleDetails}`);
    const expanded=btn.getAttribute('aria-expanded')==='true';
    btn.setAttribute('aria-expanded',String(!expanded));panel.hidden=expanded;btn.textContent=expanded?'Show full details':'Hide full details';
  }));
  target.querySelectorAll('[data-status-for]').forEach(el=>el.addEventListener('change',()=>{if(el.value){const status=el.value;el.value='';updateDeliveryStatus(el.dataset.statusFor,status);}}));
  target.querySelectorAll('[data-cod-order]').forEach(btn=>btn.addEventListener('click',()=>confirmDriverCOD(btn.dataset.codOrder)));
  target.querySelectorAll('[data-retry-order]').forEach(btn=>btn.addEventListener('click',()=>retryFailedDelivery(btn.dataset.retryOrder)));
}

async function updateDeliveryStatus(orderId,status){
  const failed=status==='failed';
  let reason='';
  if(failed){reason=window.prompt('Enter the reason delivery failed (for example, customer unavailable or address issue):','Customer unavailable')?.trim()||'';if(!reason){window.showToast('Please enter a reason for the failed delivery.','error');return;}}
  if(!await window.showConfirmModal({title:failed?'Record failed delivery?':status==='completed'?'Confirm delivery completed?':'Start delivery?',message:failed?`Record this unsuccessful attempt? Reason: ${reason}`:status==='completed'?'Confirm that the order was physically delivered to the customer.':'Confirm that you are starting this delivery.',confirmText:failed?'Record attempt':status==='completed'?'Mark delivered':'Start delivery',cancelText:'Cancel',danger:failed}))return;
  try{
    const update={deliveryStatus:status,updatedAt:serverTimestamp()};
    if(status==='completed') update.completedAt=serverTimestamp();
    if(failed) {
      const history=Array.isArray(assignedOrders.find(order=>order.id===orderId)?.deliveryAttemptHistory)?assignedOrders.find(order=>order.id===orderId).deliveryAttemptHistory:[];
      update.failedAt=serverTimestamp();
      update.deliveryAttemptHistory=arrayUnion({attemptNumber:history.length+1,reason,driverId:auth.currentUser.uid,failedAt:new Date().toISOString()});
    }
    await updateDoc(doc(db,'orders',orderId),update);if(failed)activeFilter='failed';window.showToast(failed?'Failed delivery recorded. You can retry after confirming with the customer.':'Delivery status updated.','success');await loadDriverDeliveriesView();
  }
  catch(err){window.showToast('Could not update delivery: '+err.message,'error');await loadDriverDeliveriesView();}
}
async function retryFailedDelivery(orderId){
  const button=document.querySelector(`[data-retry-order="${CSS.escape(orderId)}"]`);
  if(button?.disabled)return;
  if(!await window.showConfirmModal({title:'Retry delivery?',message:'Confirm that you contacted the customer and they agreed to another delivery attempt. The order will return to Ready for Dispatch and remain assigned to you. Payment, sale, and receipt records will not be recreated.',confirmText:'Retry Delivery',cancelText:'Go back'}))return;
  if(button){button.disabled=true;button.textContent='Retrying…';}
  try{
    const orderRef=doc(db,'orders',orderId);
    const snap=await getDoc(orderRef);
    if(!snap.exists())throw new Error('Order not found.');
    const order=snap.data();
    if(order.type!=='delivery'||order.assignedDriverId!==auth.currentUser.uid||order.deliveryStatus!=='failed')throw new Error('This failed delivery is no longer assigned to you or has already changed. Refresh and try again.');
    await updateDoc(orderRef,{deliveryStatus:'ready_for_dispatch',failedDeliveryDecision:'retry',failedDeliveryDecisionAt:serverTimestamp(),failedDeliveryDecisionBy:auth.currentUser.uid,updatedAt:serverTimestamp()});
    activeFilter='pending';window.showToast('Delivery retry recorded. The order is ready for dispatch and remains assigned to you.','success');
  }catch(err){window.showToast('Could not retry delivery: '+err.message,'error');}
  finally{await loadDriverDeliveriesView();}
}

async function confirmDriverCOD(orderId){
  const button=document.querySelector(`[data-cod-order="${CSS.escape(orderId)}"]`);
  if(button?.disabled)return;
  if(!await window.showConfirmModal({title:'Confirm cash collected?',message:'Only continue while this order is Out for Delivery and after the customer has physically paid the exact COD amount. Confirming cash also marks the delivery completed and creates the official sale and receipt.',confirmText:'Confirm cash',cancelText:'Cancel'}))return;
  if(button){button.disabled=true;button.textContent='Confirming…';}
  try{const result=await apiConfirmCODPayment(orderId);window.showToast(`Cash payment recorded. Receipt: ${result.receiptNumber}`,'success');}
  catch(err){window.showToast('Could not record cash payment: '+err.message,'error');}
  finally{await loadDriverDeliveriesView();}
}
function millis(v){return v?.toMillis?v.toMillis():v?.seconds?v.seconds*1000:0;}
function fmtDate(v){const n=millis(v);return n?new Date(n).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';}
function formatAttemptDate(value){const date=value?.toDate?value.toDate():new Date(value||'');return date&&!Number.isNaN(date.getTime())?date.toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';}
function statusLabel(v){const key=String(v||'unknown').toLowerCase();const labels={pending:'Pending',accepted:'Confirmed',preparing:'Processing',processing:'Processing',ready_for_pickup:'Ready for Pickup',ready_for_dispatch:'Ready for Dispatch',out_for_delivery:'Out for Delivery',delivered:'Delivered',completed:'Completed',failed:'Delivery Failed',cancelled:'Cancelled',unpaid:'Unpaid',pending_verification:'Verifying Payment',paid:'Paid',rejected:'Payment Rejected',refund_pending:'Refund Pending',refunded:'Refunded',cod:'Cash on Delivery',online:'GCash',gcash:'GCash'};return labels[key]||key.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}


// Guard Driver delivery-status and COD payment actions until their async workflow completes.
updateDeliveryStatus = window.guardAsyncAction((orderId, status) => `driver-status:${orderId}:${status}`, updateDeliveryStatus);
confirmDriverCOD = window.guardAsyncAction((orderId) => `driver-cod:${orderId}`, confirmDriverCOD);
retryFailedDelivery = window.guardAsyncAction((orderId) => `driver-retry:${orderId}`, retryFailedDelivery);
