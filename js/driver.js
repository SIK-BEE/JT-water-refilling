import { loadTeamProfileView } from "./team-profile.js";
import { auth, db } from "./firebase-init.js";
import { collection, query, where, getDocs, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { apiConfirmCODPayment } from "./api.js";

let assignedOrders = [];
let activeFilter = 'all';

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
  content.innerHTML=`<section class="workflow-page"><header class="workflow-heading"><div><h2>Assigned Deliveries</h2><p>Manage your assigned deliveries, update progress, and record cash collection.</p></div><button type="button" class="btn-secondary" id="driver-refresh">↻ Refresh</button></header><div class="workflow-stats"><article class="workflow-stat"><span>All Assigned</span><strong id="driver-stat-all">—</strong></article><article class="workflow-stat"><span>To Deliver</span><strong id="driver-stat-pending">—</strong></article><article class="workflow-stat"><span>Completed</span><strong id="driver-stat-done">—</strong></article></div><div class="workflow-toolbar"><label class="workflow-search"><span class="sr-only">Search deliveries</span><input id="driver-order-search" type="search" placeholder="Search customer, order ID, address, phone…"></label><div class="workflow-filter" role="group" aria-label="Filter deliveries"><button type="button" class="active" data-filter="all">All</button><button type="button" data-filter="active">In progress</button><button type="button" data-filter="done">Completed</button></div></div><div id="driver-deliveries-list" class="workflow-list" aria-live="polite"><div class="workflow-empty">Loading assigned deliveries…</div></div><p class="workflow-note">For COD orders, confirm collection only after receiving the cash. Delivery completion and payment confirmation are tracked separately.</p></section>`;
  document.getElementById('driver-refresh').addEventListener('click',loadDriverDeliveriesView);
  document.getElementById('driver-order-search').addEventListener('input',renderDeliveries);
  document.querySelectorAll('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{activeFilter=btn.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===btn));renderDeliveries();}));
  const target=document.getElementById('driver-deliveries-list');
  try {
    const q=query(collection(db,'orders'),where('type','==','delivery'),where('assignedDriverId','==',auth.currentUser.uid));
    const snap=await getDocs(q);
    assignedOrders=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>millis(b.createdAt)-millis(a.createdAt));
    document.getElementById('driver-stat-all').textContent=assignedOrders.length;
    document.getElementById('driver-stat-pending').textContent=assignedOrders.filter(o=>!['completed','failed'].includes(o.deliveryStatus)).length;
    document.getElementById('driver-stat-done').textContent=assignedOrders.filter(o=>o.deliveryStatus==='completed').length;
    renderDeliveries();
  } catch(err) { target.innerHTML=`<div class="workflow-empty"><strong>Deliveries could not be loaded</strong>${esc(err.message)}</div>`; }
}
function renderDeliveries(){
  const target=document.getElementById('driver-deliveries-list');if(!target)return;
  const q=(document.getElementById('driver-order-search')?.value||'').trim().toLowerCase();
  const filtered=assignedOrders.filter(o=>{const status=String(o.deliveryStatus||'pending');const inFilter=activeFilter==='all'||(activeFilter==='active'&&!['completed','failed'].includes(status))||(activeFilter==='done'&&status==='completed');return inFilter&&`${o.id} ${o.customerName||''} ${o.deliveryAddress||''} ${o.contactNumber||''}`.toLowerCase().includes(q);});
  if(!filtered.length){target.innerHTML='<div class="workflow-empty"><strong>No matching deliveries</strong>Assigned deliveries will appear here when the Admin assigns them to you.</div>';return;}
  target.innerHTML=filtered.map(o=>{
    const id=esc(o.id),status=String(o.deliveryStatus||'pending'),paid=o.paymentStatus==='paid',method=String(o.paymentMethod||'cod');
    const items=Array.isArray(o.items)?o.items.map(i=>`${esc(i.name||'Item')} × ${Number(i.quantity||0)}`).join(', '):'Order items unavailable';
    const next=(status==='ready_for_dispatch'||status==='ready_for_pickup')?[['out_for_delivery','Start delivery']]:status==='out_for_delivery'?[...(method!=='cod'||paid?[['completed','Mark delivered']]:[]),['failed','Failed attempt']]:[];
    return `<article class="workflow-order"><div class="workflow-order-head"><div class="workflow-order-title"><strong>${esc(o.customerName||'Customer')}</strong><small>Order #${id.slice(0,8)} · ${fmtDate(o.createdAt)}</small></div><div class="workflow-order-total">₱${Number(o.totalAmount||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div><div class="workflow-order-grid"><div class="workflow-detail"><span>Delivery address</span><strong>${esc(o.deliveryAddress||'No address provided')}</strong></div><div class="workflow-detail"><span>Contact number</span><strong>${esc(o.contactNumber||'Not provided')}</strong></div><div class="workflow-detail"><span>Order items</span><strong>${items}</strong></div><div class="workflow-detail"><span>Delivery status</span><strong>${esc(statusLabel(status))}</strong></div><div class="workflow-detail"><span>Payment</span><strong>${esc(statusLabel(method))} · ${paid?'Paid':esc(statusLabel(o.paymentStatus||'unpaid'))}</strong></div><div class="workflow-detail"><span>Customer note</span><strong>${esc(o.note||'—')}</strong></div></div><div class="workflow-order-actions">${next.length?`<select aria-label="Update delivery ${id.slice(0,8)} status" data-status-for="${id}"><option value="">Update delivery status…</option>${next.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>`:''}${method==='cod'&&!paid?`<button type="button" class="btn-primary" data-cod-order="${id}">Confirm cash collected</button>`:''}</div></article>`;
  }).join('');
  target.querySelectorAll('[data-status-for]').forEach(el=>el.addEventListener('change',()=>{if(el.value){const status=el.value;el.value='';updateDeliveryStatus(el.dataset.statusFor,status);}}));
  target.querySelectorAll('[data-cod-order]').forEach(btn=>btn.addEventListener('click',()=>confirmDriverCOD(btn.dataset.codOrder)));
}
async function updateDeliveryStatus(orderId,status){
  const failed=status==='failed';
  if(!await window.showConfirmModal({title:failed?'Record failed delivery?':status==='completed'?'Confirm delivery completed?':'Start delivery?',message:failed?'This records an unsuccessful delivery attempt.':status==='completed'?'Confirm that the order was physically delivered to the customer.':'Confirm that you are starting this delivery.',confirmText:failed?'Record attempt':status==='completed'?'Mark delivered':'Start delivery',cancelText:'Cancel',danger:failed}))return;
  try{await updateDoc(doc(db,'orders',orderId),{deliveryStatus:status,updatedAt:serverTimestamp()});window.showToast('Delivery status updated.','success');await loadDriverDeliveriesView();}
  catch(err){window.showToast('Could not update delivery: '+err.message,'error');await loadDriverDeliveriesView();}
}
async function confirmDriverCOD(orderId){
  const button=document.querySelector(`[data-cod-order="${CSS.escape(orderId)}"]`);
  if(button?.disabled)return;
  if(!await window.showConfirmModal({title:'Confirm cash collected?',message:'Only continue if the customer has physically paid the exact COD amount. For COD deliveries, confirming cash also marks the delivery completed and creates the official sale and receipt.',confirmText:'Confirm cash',cancelText:'Cancel'}))return;
  if(button){button.disabled=true;button.textContent='Processing…';}
  try{const result=await apiConfirmCODPayment(orderId);window.showToast(`Cash payment recorded. Receipt: ${result.receiptNumber}`,'success');}
  catch(err){window.showToast('Could not record cash payment: '+err.message,'error');}
  finally{await loadDriverDeliveriesView();}
}
function millis(v){return v?.toMillis?v.toMillis():v?.seconds?v.seconds*1000:0;}
function fmtDate(v){const n=millis(v);return n?new Date(n).toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'}):'Date unavailable';}
function statusLabel(v){return String(v||'unknown').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
