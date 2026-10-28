import { auth, db } from "./firebase-init.js";
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider, updateProfile } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, getDocs, addDoc, doc, getDoc, setDoc, updateDoc, serverTimestamp, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let customerOrdersUnsubscribe = null;
let customerOrderNotificationCount = 0;
let customerUnreadOrderIds = new Set();
let customerOrderNotificationPrimed = false;
let customerOrderStateById = new Map();

const DEFAULT_MESSENGER_URL = "https://www.facebook.com/messages/e2ee/t/7567875863274540"; // temporary testing link; replace with the official Page Messenger link later

export async function initCustomerDashboard() {
    const nav = document.getElementById('sidebar-nav');
    nav.innerHTML = `<a href="#" class="nav-link active" data-target="catalog"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 1.9-1.4L21 8H6M10 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm7 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg></span><span>Product Catalog &amp; Order</span></a><a href="#" class="nav-link" data-target="my-orders"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M3 5h11v11H3zM14 9h4l3 3v4h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg></span><span>My Orders &amp; Tracking</span><span class="customer-order-notification-badge" id="customer-order-notification-badge" hidden>0</span></a><a href="#" class="nav-link" data-target="receipts"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6M9 15h4"/></svg></span><span>My Receipts</span></a><a href="#" class="nav-link" data-target="profile"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><span>My Profile</span></a>`;
    setupCustomerNavigation();
    startCustomerOrderNotifications();
    loadCatalogView();
}
function startCustomerOrderNotifications() {
  if (customerOrdersUnsubscribe) customerOrdersUnsubscribe();
  const user = auth.currentUser;
  if (!user) return;
  customerOrderNotificationPrimed = false;
  customerOrderStateById = new Map();
  customerOrdersUnsubscribe = onSnapshot(query(collection(db, 'orders'), where('customerId', '==', user.uid)), snapshot => {
    if (!customerOrderNotificationPrimed) {
      snapshot.docs.forEach(d => customerOrderStateById.set(d.id, `${d.data().deliveryStatus || 'pending'}|${d.data().paymentStatus || 'unpaid'}|${d.data().cancellationRequestStatus || 'none'}|${d.data().refundStatus || 'none'}`));
      customerOrderNotificationPrimed = true;
      return;
    }
    let newOrders = 0;
    let updatedOrders = 0;
    const changedOrderIds = new Set();
    snapshot.docChanges().forEach(change => {
      const data = change.doc.data();
      const state = `${data.deliveryStatus || 'pending'}|${data.paymentStatus || 'unpaid'}|${data.cancellationRequestStatus || 'none'}|${data.refundStatus || 'none'}`;
      if (change.type === 'added' && !customerOrderStateById.has(change.doc.id)) {
        newOrders += 1; changedOrderIds.add(change.doc.id);
      } else if (change.type === 'modified' && customerOrderStateById.has(change.doc.id) && customerOrderStateById.get(change.doc.id) !== state) {
        updatedOrders += 1; changedOrderIds.add(change.doc.id);
      }
      customerOrderStateById.set(change.doc.id, state);
    });
    const notificationTotal = newOrders + updatedOrders;
    if (notificationTotal) {
      changedOrderIds.forEach(id => customerUnreadOrderIds.add(id));
      customerOrderNotificationCount = customerUnreadOrderIds.size;
      const badge = document.getElementById('customer-order-notification-badge');
      if (badge) { badge.textContent = String(customerOrderNotificationCount); badge.hidden = customerOrderNotificationCount < 1; }
      if (document.visibilityState === 'visible') {
        const message = newOrders && updatedOrders
          ? `${newOrders} new order${newOrders === 1 ? '' : 's'} and ${updatedOrders} order update${updatedOrders === 1 ? '' : 's'}.`
          : newOrders
            ? (newOrders === 1 ? 'Your new order was received.' : `${newOrders} new orders were received.`)
            : (updatedOrders === 1 ? 'Your order has an update.' : `${updatedOrders} of your orders have updates.`);
        window.showToast(message, 'info');
      }
    }
  }, err => console.warn('Customer order notifications unavailable:', err));
}
function clearCustomerOrderNotifications() {
  customerOrderNotificationCount = 0;
  customerUnreadOrderIds.clear();
  const badge = document.getElementById('customer-order-notification-badge');
  if (badge) { badge.textContent = '0'; badge.hidden = true; }
}
function setupCustomerNavigation() {
    const links = document.querySelectorAll('.nav-link');
    links.forEach(link => link.addEventListener('click', e => {
        e.preventDefault(); links.forEach(l => l.classList.remove('active')); link.classList.add('active');
        const target = link.getAttribute('data-target');
        if (target === 'catalog') loadCatalogView(); else if (target === 'my-orders') { clearCustomerOrderNotifications(); loadMyOrdersView(); } else if (target === 'receipts') loadReceiptsView(); else if (target === 'profile') loadCustomerProfileView();
    }));
}

async function loadCatalogView() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
      <section class="customer-order-page">
        <div class="customer-product-list" id="product-list" aria-live="polite"><div class="card">Loading products...</div></div>
        <section class="customer-checkout-panel" aria-label="Order details">
          <div class="customer-fulfillment-toggle" role="group" aria-label="Choose delivery or pickup">
            <span class="customer-fulfillment-thumb" aria-hidden="true"></span>
            <button type="button" class="customer-fulfillment-btn active" data-fulfillment="delivery" aria-pressed="true">Deliver</button>
            <button type="button" class="customer-fulfillment-btn" data-fulfillment="pickup" aria-pressed="false">Pickup</button>
          </div>
          <div class="customer-checkout-field">
            <label>Address</label>
            <div class="customer-address-summary" id="customer-address-summary">Loading station details…</div>
          </div>
          <form id="order-form" class="customer-order-form">
            <div class="customer-checkout-field" id="customer-name-field">
              <label for="order-customer-name">Customer Name</label>
              <input type="text" id="order-customer-name" maxlength="120" required placeholder="Enter name" autocomplete="name">
            </div>
            <div class="customer-checkout-field" id="customer-delivery-address-field" hidden>
              <label for="order-address">Delivery Address</label>
              <textarea id="order-address" maxlength="250" placeholder="House No., Street, Barangay" autocomplete="street-address"></textarea>
            </div>
            <div class="customer-checkout-field">
              <label>Items</label>
              <div id="order-items-summary" class="customer-items-summary">Nothing selected yet.</div>
            </div>
            <div class="customer-checkout-bottom">
              <div class="customer-order-total">Total: <strong id="order-total">₱0.00</strong><small id="delivery-fee-note"></small></div>
            </div>
            <div class="customer-checkout-field customer-payment-field">
              <label for="order-payment">Payment Method</label>
              <select id="order-payment" required><option value="cod">Cash on Delivery (COD)</option><option value="online">GCash</option></select>
            </div>
            <div class="customer-checkout-submit-row"><button type="submit" class="customer-place-order-btn">Place Order</button></div>
          </form>
        </section>
      </section>`;

    const list = document.getElementById('product-list');
    const orderForm = document.getElementById('order-form');
    const addressSummary = document.getElementById('customer-address-summary');
    const deliveryAddressField = document.getElementById('customer-delivery-address-field');
    const customerNameInput = document.getElementById('order-customer-name');
    const addressInput = document.getElementById('order-address');
    const paymentSelect = document.getElementById('order-payment');
    const itemsSummary = document.getElementById('order-items-summary');
    const totalEl = document.getElementById('order-total');
    const feeNote = document.getElementById('delivery-fee-note');
    let stationSettings = { stationAddress: 'JT Water Refilling Station, 386 Sampaguita St., Brgy. Pansahan, Malolos, Bulacan', operatingHours: '7:00 AM - 4:00 PM', stationContactNumber: '', deliveryFeeEnabled: false, deliveryFeeAmount: 0 };
    try { const stationSnap = await getDoc(doc(db, 'paymentSettings', 'config')); if (stationSnap.exists()) stationSettings = { ...stationSettings, ...stationSnap.data() }; } catch (err) { console.warn('Could not load station settings:', err); }
    const STATION_ADDRESS = stationSettings.stationAddress || 'JT Water Refilling Station, 386 Sampaguita St., Brgy. Pansahan, Malolos, Bulacan';
    const STATION_HOURS = stationSettings.operatingHours || '7:00 AM - 4:00 PM';
    const STATION_CONTACT = stationSettings.stationContactNumber || '';
    const DELIVERY_FEE = stationSettings.deliveryFeeEnabled === true ? Math.max(0, Number(stationSettings.deliveryFeeAmount || 0)) : 0;
    let fulfillmentType = 'pickup';
    let products = [];
    const quantities = new Map();
    let profile = { fullName: auth.currentUser?.displayName || '', address: '', phoneNumber: '' };

    try {
      if (auth.currentUser) {
        const profileSnap = await getDoc(doc(db, 'users', auth.currentUser.uid));
        if (profileSnap.exists()) {
          const u = profileSnap.data();
          profile = {
            fullName: u.fullName || auth.currentUser.displayName || '',
            address: u.address || '',
            phoneNumber: u.phoneNumber || ''
          };
        }
      }
    } catch (err) { console.warn('Could not load customer profile defaults:', err); }
    customerNameInput.value = profile.fullName;
    addressInput.value = profile.address;

    function money(value) { return `₱${Number(value || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`; }
    function selectedProducts() { return products.filter(p => (quantities.get(p.id) || 0) > 0); }
    function renderSummary() {
      const chosen = selectedProducts();
      if (!chosen.length) itemsSummary.textContent = 'Nothing selected yet.';
      else itemsSummary.innerHTML = chosen.map(p => `<div class="customer-summary-line"><span>${escapeHtml(p.name)} × ${quantities.get(p.id)}</span><strong>${money(Number(p.price) * quantities.get(p.id))}</strong></div>`).join('');
      const subtotal = chosen.reduce((sum, p) => sum + Number(p.price) * quantities.get(p.id), 0);
      const total = subtotal + (fulfillmentType === 'delivery' && chosen.length && stationSettings.deliveryFeeEnabled === true ? DELIVERY_FEE : 0);
      totalEl.textContent = money(total);
      feeNote.textContent = fulfillmentType === 'delivery' && chosen.length && stationSettings.deliveryFeeEnabled === true && DELIVERY_FEE > 0 ? `Includes ${money(DELIVERY_FEE)} delivery fee` : '';
    }
    function renderProducts() {
      if (!products.length) { list.innerHTML = '<div class="card"><p>No active products available yet. Please contact the station.</p></div>'; return; }
      list.innerHTML = products.map(p => {
        const qty = quantities.get(p.id) || 0;
        const isContainer = /rectangular|container|jerry|can/i.test(p.name || '');
        const fallbackImage = isContainer ? 'assets/Gallon_2.png' : 'assets/Gallon_1.png';
        const imageMarkup = p.imageUrl || p.image || p.photoURL || fallbackImage
          ? `<img class="customer-product-image" src="${escapeAttr(p.imageUrl || p.image || p.photoURL || fallbackImage)}" alt="${escapeAttr(p.name)}" loading="lazy">`
          : `<div class="customer-product-placeholder" aria-hidden="true">${isContainer ? '▰' : '◉'}</div>`;
        return `<article class="customer-product-card" data-product-id="${escapeAttr(p.id)}">
          <div class="customer-product-visual">${imageMarkup}</div>
          <div class="customer-product-info"><h3>${escapeHtml(p.name || 'Product')}</h3><p>${money(p.price)}${p.unit ? ` / ${escapeHtml(p.unit)}` : ''}</p>${p.description ? `<small>${escapeHtml(p.description)}</small>` : ''}</div>
          <div class="customer-quantity-control" aria-label="Quantity for ${escapeAttr(p.name)}"><button type="button" class="customer-qty-btn" data-qty-change="-1" data-product-id="${escapeAttr(p.id)}" aria-label="Decrease ${escapeAttr(p.name)} quantity" ${qty <= 0 ? 'disabled' : ''}>−</button><output>${qty}</output><button type="button" class="customer-qty-btn" data-qty-change="1" data-product-id="${escapeAttr(p.id)}" aria-label="Increase ${escapeAttr(p.name)} quantity" ${qty >= 100 ? 'disabled' : ''}>+</button></div>
        </article>`;
      }).join('');
      renderSummary();
    }
    function setFulfillment(type) {
      fulfillmentType = type;
      const codOption = document.querySelector('#order-payment option[value="cod"]');
      if (codOption) codOption.textContent = type === 'delivery' ? 'Cash on Delivery (COD)' : 'Cash on Pickup';
      const fulfillmentToggle = document.querySelector('.customer-fulfillment-toggle');
      if (fulfillmentToggle) fulfillmentToggle.dataset.active = type;
      document.querySelectorAll('.customer-fulfillment-btn').forEach(btn => {
        const active = btn.dataset.fulfillment === type;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      if (type === 'delivery') {
        addressSummary.innerHTML = `<strong>${escapeHtml(profile.fullName || customerNameInput.value || 'Customer')}</strong><br>${escapeHtml(profile.address || addressInput.value || 'Please add your delivery address below.')}`;
        deliveryAddressField.hidden = Boolean(profile.address);
        customerNameInput.closest('.customer-checkout-field').hidden = true;
        addressInput.required = !profile.address;
        feeNote.textContent = selectedProducts().length && stationSettings.deliveryFeeEnabled === true && DELIVERY_FEE > 0 ? `Includes ${money(DELIVERY_FEE)} delivery fee` : '';
      } else {
        addressSummary.innerHTML = `${escapeHtml(STATION_ADDRESS)}<br>Operating Hours: ${escapeHtml(STATION_HOURS)}${STATION_CONTACT ? `<br>Contact: ${escapeHtml(STATION_CONTACT)}` : ''}`;
        deliveryAddressField.hidden = true;
        customerNameInput.closest('.customer-checkout-field').hidden = false;
        addressInput.required = false;
      }
      renderSummary();
    }
    document.querySelectorAll('.customer-fulfillment-btn').forEach(btn => btn.addEventListener('click', () => setFulfillment(btn.dataset.fulfillment)));
    list.addEventListener('click', e => {
      const button = e.target.closest('[data-qty-change]');
      if (!button || button.disabled) return;
      const id = button.dataset.productId;
      const current = quantities.get(id) || 0;
      const delta = Number(button.dataset.qtyChange);
      if (delta > 0 && current === 0 && selectedProducts().length >= 10) {
        window.showToast('You can include up to 10 different product types per order. Remove one item first to add another.', 'info');
        return;
      }
      quantities.set(id, Math.max(0, Math.min(100, current + delta)));
      renderProducts();
    });

    try {
      const snap = await getDocs(collection(db, 'products'));
      snap.forEach(d => { const p = d.data(); if (p.active === false) return; products.push({ id: d.id, ...p }); quantities.set(d.id, 0); });
      products.sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
      renderProducts();
    } catch (err) {
      list.innerHTML = `<div class="card"><p class="error-msg">Failed to load products: ${escapeHtml(err.message)}</p></div>`;
    }

    let orderConfirmationApproved = false;
    let orderReviewOpening = false;
    let orderSubmissionInProgress = false;
    async function showOrderConfirmation() {
      let confirmGcashSettings = {};
      if (paymentSelect.value === 'online') { try { const settingsSnap = await getDoc(doc(db, 'paymentSettings', 'config')); if (settingsSnap.exists()) confirmGcashSettings = settingsSnap.data(); } catch (err) { console.warn('Could not load GCash details for confirmation:', err); } }
      const chosen = selectedProducts();
      const items = chosen.map(p => `<div class="customer-confirm-item"><span>${escapeHtml(p.name || 'Product')} × ${Number(quantities.get(p.id) || 0)}</span><strong>${money(Number(p.price) * Number(quantities.get(p.id) || 0))}</strong></div>`).join('');
      const subtotal = chosen.reduce((sum, p) => sum + Number(p.price) * Number(quantities.get(p.id) || 0), 0);
      const fee = fulfillmentType === 'delivery' && stationSettings.deliveryFeeEnabled === true ? DELIVERY_FEE : 0;
      const total = subtotal + fee;
      const typeLabel = fulfillmentType === 'delivery' ? 'Delivery' : 'Pickup';
      const paymentLabel = paymentSelect.value === 'online' ? 'GCash' : (fulfillmentType === 'delivery' ? 'Cash on Delivery (COD)' : 'Cash on Pickup');
      const addressLabel = fulfillmentType === 'delivery' ? addressInput.value.trim() : `Pickup at Station — ${STATION_ADDRESS}`;
      const modal = document.createElement('div');
      modal.className = 'customer-order-confirm-overlay';
      modal.innerHTML = `<section class="customer-order-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="customer-order-confirm-title">
        <button type="button" class="customer-order-confirm-close" aria-label="Close confirmation">×</button>
        <h2 id="customer-order-confirm-title">Confirm your order</h2>
        <p class="customer-order-confirm-subtitle">Please review your items before placing the order.</p>
        <div class="customer-order-confirm-items">${items}</div>
        <div class="customer-order-confirm-meta"><span>Order type</span><strong>${typeLabel}</strong></div>
        <div class="customer-order-confirm-meta"><span>${fulfillmentType === 'delivery' ? 'Delivery address' : 'Pickup location'}</span><strong>${escapeHtml(addressLabel)}</strong></div>
        <div class="customer-order-confirm-total"><span>Total${fee ? ` (includes ₱${fee.toFixed(2)} delivery fee)` : ''}</span><strong>${money(total)}</strong></div>
        <div class="customer-order-confirm-meta customer-order-confirm-payment"><span>Payment method</span><strong>${paymentLabel}</strong></div>
        ${paymentSelect.value === 'online' ? `<div class="customer-order-confirm-gcash"><strong>Pay with GCash before confirming</strong><div class="customer-confirm-gcash-recipient">${confirmGcashSettings.gcashQrImage ? `<span>SCAN THE OWNER'S OFFICIAL QR CODE</span><img src="${escapeAttr(confirmGcashSettings.gcashQrImage)}" alt="Owner's GCash QR code"><small>Verify the recipient name shown in the GCash app before sending payment.</small>` : '<strong>GCash QR is not configured</strong><small>Please contact the Owner. Do not send payment until the official QR code is available.</small>'}</div><p>1. Pay the exact total shown above. 2. Attach a screenshot of the successful payment below. Your order will be sent to the Owner for verification.</p>${confirmGcashSettings.gcashQrImage ? `<label class="customer-confirm-proof-label" for="customer-confirm-proof-file">Payment screenshot <span>*</span></label><input id="customer-confirm-proof-file" class="customer-confirm-proof-input" type="file" accept="image/*"><div class="customer-confirm-proof-preview" hidden><img alt="Payment screenshot preview"><span></span><button type="button" class="customer-confirm-proof-remove">Remove</button></div><p class="customer-confirm-proof-status" role="status">Attach your payment screenshot to enable confirmation.</p>` : `<p class="customer-confirm-proof-status" role="status">GCash payment is unavailable until the Owner uploads the official QR code.</p>`}</div>` : ''}
        <p class="customer-order-confirm-note">You can cancel while the order is still awaiting processing and payment has not been confirmed.</p>
        <div class="customer-order-confirm-actions"><button type="button" class="customer-order-confirm-back">Review order</button><button type="button" class="customer-order-confirm-place" ${paymentSelect.value === 'online' ? 'disabled' : ''}>Confirm &amp; Place Order</button></div>
      </section>`;
      document.body.appendChild(modal);
      let confirmationProofImage = null;
      const close = () => modal.remove();
      modal.querySelector('.customer-order-confirm-close').addEventListener('click', close);
      modal.querySelector('.customer-order-confirm-back').addEventListener('click', close);
      modal.addEventListener('click', e => { if (e.target === modal) close(); });
      const proofInput = modal.querySelector('#customer-confirm-proof-file');
      const confirmButton = modal.querySelector('.customer-order-confirm-place');
      if (proofInput) {
        const previewWrap = modal.querySelector('.customer-confirm-proof-preview');
        const status = modal.querySelector('.customer-confirm-proof-status');
        proofInput.addEventListener('change', async () => {
          const file = proofInput.files?.[0];
          if (!file) return;
          confirmButton.disabled = true;
          status.textContent = 'Preparing screenshot…';
          try {
            confirmationProofImage = await readPaymentImage(file);
            previewWrap.querySelector('img').src = confirmationProofImage;
            previewWrap.querySelector('span').textContent = file.name;
            previewWrap.hidden = false;
            status.textContent = 'Payment screenshot attached. You can now confirm your order.';
            confirmButton.disabled = false;
          } catch (err) {
            confirmationProofImage = null; proofInput.value = ''; previewWrap.hidden = true;
            status.textContent = err.message || 'Could not prepare screenshot.';
          }
        });
        modal.querySelector('.customer-confirm-proof-remove').addEventListener('click', () => {
          confirmationProofImage = null; proofInput.value = ''; previewWrap.hidden = true;
          status.textContent = 'Attach your payment screenshot to enable confirmation.';
          confirmButton.disabled = true;
        });
      }
      confirmButton.addEventListener('click', () => {
        if (confirmButton.dataset.submitting === 'true') return;
        if (paymentSelect.value === 'online' && !confirmationProofImage) {
          window.showToast('Please attach your GCash payment screenshot first.', 'error'); return;
        }
        confirmButton.dataset.submitting = 'true';
        confirmButton.disabled = true;
        confirmButton.textContent = 'Confirming…';
        orderConfirmationApproved = true;
        orderForm.dataset.confirmationProof = confirmationProofImage || '';
        close();
        if (typeof orderForm.requestSubmit === 'function') orderForm.requestSubmit();
        else orderForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }

    orderForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!orderConfirmationApproved) {
        if (orderReviewOpening || orderSubmissionInProgress) return;
        const chosen = selectedProducts();
        if (!chosen.length) { window.showToast('Please choose at least one product using the + button.', 'error'); return; }
        const customerName = customerNameInput.value.trim();
        const address = addressInput.value.trim();
        if (!customerName) { window.showToast('Please enter the customer name.', 'error'); customerNameInput.focus(); return; }
        if (fulfillmentType === 'delivery' && !address) { window.showToast('Please enter your delivery address.', 'error'); addressInput.focus(); return; }
        const reviewButton = orderForm.querySelector('.customer-place-order-btn');
        orderReviewOpening = true;
        window.setButtonLoading(reviewButton, true, 'Preparing…');
        try { await showOrderConfirmation(); }
        catch (err) { window.showToast('Could not prepare order review: ' + err.message, 'error'); }
        finally { orderReviewOpening = false; window.setButtonLoading(reviewButton, false); }
        return;
      }
      if (orderSubmissionInProgress) return;
      orderConfirmationApproved = false;
      const submitButton = orderForm.querySelector('.customer-place-order-btn');
      if (submitButton?.disabled) return;
      const chosen = selectedProducts();
      if (!chosen.length) { window.showToast('Please choose at least one product using the + button.', 'error'); return; }
      const customerName = customerNameInput.value.trim();
      const address = addressInput.value.trim();
      const phone = profile.phoneNumber || '';
      if (!customerName) { window.showToast('Please enter the customer name.', 'error'); customerNameInput.focus(); return; }
      if (fulfillmentType === 'delivery' && !address) { window.showToast('Please enter your delivery address.', 'error'); addressInput.focus(); return; }
      orderSubmissionInProgress = true;
      const paymentMethod = paymentSelect.value;
      const items = chosen.map(p => ({ productId: p.id, name: p.name || 'Product', quantity: quantities.get(p.id), unitPrice: Number(p.price), subtotal: Number(p.price) * quantities.get(p.id) }));
      const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
      const appliedDeliveryFee = fulfillmentType === 'delivery' && stationSettings.deliveryFeeEnabled === true ? DELIVERY_FEE : 0;
      const totalAmount = subtotal + appliedDeliveryFee;
      const orderData = {
        customerId: auth.currentUser.uid,
        customerName: fulfillmentType === 'delivery' ? (profile.fullName || customerName || auth.currentUser.displayName || auth.currentUser.email) : customerName,
        items,
        subtotal,
        deliveryFee: appliedDeliveryFee,
        totalAmount,
        type: fulfillmentType,
        paymentMethod,
        paymentStatus: 'unpaid',
        deliveryStatus: fulfillmentType === 'pickup' ? 'ready_for_pickup' : 'pending',
        deliveryAddress: fulfillmentType === 'delivery' ? address : `Pickup at Station — ${STATION_ADDRESS}`,
        stationAddress: STATION_ADDRESS,
        operatingHours: STATION_HOURS,
        stationContactNumber: STATION_CONTACT,
        contactNumber: profile.phoneNumber || phone || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      window.setButtonLoading(submitButton, true, 'Placing…');
      try {
        const orderRef = doc(collection(db, 'orders'));
        await setDoc(orderRef, orderData);
        if (paymentMethod === 'online') {
          const proofImage = orderForm.dataset.confirmationProof || '';
          if (!proofImage) throw new Error('Order was created, but the payment screenshot was missing. Please contact the Owner before placing another order.');
          await setDoc(doc(db, 'payments', orderRef.id), {
            id: orderRef.id, orderId: orderRef.id, customerId: auth.currentUser.uid,
            customerName: String(orderData.customerName || ''), method: 'online', amount: Number(totalAmount),
            senderName: '', referenceNumber: '', transactionDate: '', proofImageData: proofImage,
            status: 'pending', rejectionReason: '', createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
          await updateDoc(orderRef, { paymentStatus: 'pending_verification', updatedAt: serverTimestamp() });
          delete orderForm.dataset.confirmationProof;
        }
        window.showToast(paymentMethod === 'online' ? 'Order and GCash payment proof submitted. Please wait for Owner verification.' : 'Order placed successfully! You can track it under My Orders.', 'success');
        loadMyOrdersView();
      } catch (err) {
        window.showToast('Could not place order: ' + err.message, 'error');
      } finally {
        orderSubmissionInProgress = false;
        window.setButtonLoading(submitButton, false);
      }
    });
    setFulfillment('delivery');
}
async function loadCustomerProfileView() {
  const content = document.getElementById('app-content');
  const user = auth.currentUser;
  if (!user) {
    content.innerHTML = '<section class="customer-profile-page"><div class="card">Please sign in to view your profile.</div></section>';
    return;
  }

  content.innerHTML = '<section class="customer-profile-page"><div class="card">Loading profile…</div></section>';
  let data = { fullName: user.displayName || '', phoneNumber: '', address: '', photoURL: user.photoURL || '' };
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) data = { ...data, ...snap.data() };
  } catch (err) {
    window.showToast('Could not load profile: ' + err.message, 'error');
  }

  const avatarMarkup = data.photoURL
    ? `<img class="customer-profile-photo-img" src="${escapeAttr(data.photoURL)}" alt="Your profile photo">`
    : `<span class="customer-profile-photo-fallback" aria-hidden="true">${escapeHtml((data.fullName || user.email || 'U').trim().charAt(0).toUpperCase())}</span>`;

  content.innerHTML = `
    <section class="customer-profile-page">
      <section class="customer-profile-summary-card">
        <div class="customer-profile-summary-main">
          <div class="customer-profile-photo-wrap" id="customer-profile-photo-wrap">${avatarMarkup}</div>
          <div class="customer-profile-summary-text">
            <span class="customer-profile-eyebrow">CUSTOMER PROFILE</span>
            <h3>${escapeHtml(data.fullName || user.displayName || 'Your name')}</h3>
            <p class="customer-profile-summary-email">${escapeHtml(user.email || '')}</p>
            <div class="customer-profile-quick-details">
              <span><span aria-hidden="true">☎</span> ${escapeHtml(data.phoneNumber || 'No phone number added')}</span>
              <span><span aria-hidden="true">⌖</span> ${escapeHtml(data.address || 'No delivery address saved')}</span>
            </div>
          </div>
        </div>
        <div class="customer-profile-summary-actions">
          <button type="button" class="customer-profile-edit-toggle" id="customer-profile-edit-toggle"><span aria-hidden="true">✎</span> Edit profile</button>
        </div>
        <input type="file" id="customer-profile-photo-input" accept="image/*" hidden>
      </section>

      <form id="customer-profile-form" class="customer-profile-card customer-profile-edit-panel" hidden>
        <div class="customer-profile-edit-heading">
          <div class="customer-profile-edit-copy"><h3>Edit profile details</h3><p>Update your contact details or change your password below.</p></div>
        </div>
        <div class="customer-profile-cancel-row"><button type="button" class="customer-profile-change-photo" id="customer-profile-change-photo"><span aria-hidden="true">▧</span> Change photo</button></div>
        <section class="customer-profile-section">
          <div class="customer-profile-section-heading"><div><h3>Personal Information</h3><p>These details are used when you place a delivery order.</p></div></div>
          <div class="customer-profile-fields">
            <label>Full Name<input id="profile-full-name" maxlength="120" required value="${escapeAttr(data.fullName || '')}" autocomplete="name"></label>
            <label>Phone Number<input id="profile-phone" type="tel" maxlength="30" value="${escapeAttr(data.phoneNumber || '')}" autocomplete="tel"></label>
            <label class="profile-address-field">Saved Delivery Address<textarea id="profile-address" maxlength="250" rows="3" placeholder="House no., street, barangay">${escapeHtml(data.address || '')}</textarea></label>
          </div>
        </section>
        <div class="customer-profile-divider"></div>
        <section class="customer-profile-section">
          <div class="customer-profile-section-heading"><div><h3>Security &amp; Password</h3><p>Use a strong password you do not use on other websites.</p></div></div>
          <p class="customer-profile-note">Leave password fields blank if you do not want to change your password. Your current password is required to make a change.</p>
          <div class="customer-profile-fields">
            <label>Current Password<input id="profile-current-password" type="password" autocomplete="current-password"></label>
            <label>New Password<input id="profile-new-password" type="password" minlength="6" autocomplete="new-password"></label>
            <label>Confirm New Password<input id="profile-confirm-password" type="password" minlength="6" autocomplete="new-password"></label>
          </div>
        </section>
        <footer class="customer-profile-actions"><button type="button" class="customer-profile-cancel-edit" id="customer-profile-cancel-edit">Cancel</button><button class="customer-profile-save" type="submit">Save Changes</button></footer>
      </form>
    </section>`;

  const form = content.querySelector('#customer-profile-form');
  const editToggle = content.querySelector('#customer-profile-edit-toggle');
  const cancelEdit = content.querySelector('#customer-profile-cancel-edit');
  editToggle.addEventListener('click', () => {
    form.hidden = false;
    editToggle.hidden = true;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  cancelEdit.addEventListener('click', () => {
    form.hidden = true;
    editToggle.hidden = false;
  });

  const photoInput = content.querySelector('#customer-profile-photo-input');
  content.querySelector('#customer-profile-change-photo').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      window.showToast('Please choose an image file.', 'error');
      photoInput.value = '';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      window.showToast('Please choose an image smaller than 12 MB.', 'error');
      photoInput.value = '';
      return;
    }
    const changeButton = content.querySelector('#customer-profile-change-photo');
    const originalText = changeButton.innerHTML;
    changeButton.disabled = true;
    changeButton.textContent = 'Preparing photo…';
    try {
      const imageData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read this image.'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('This image could not be opened.'));
          image.onload = () => {
            const maxEdge = 360;
            const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.72));
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
      if (imageData.length > 180000) throw new Error('This photo is too large after processing. Please choose a simpler image.');
      await updateDoc(doc(db, 'users', user.uid), { photoURL: imageData, updatedAt: serverTimestamp() });
      data.photoURL = imageData;
      content.querySelector('#customer-profile-photo-wrap').innerHTML = `<img class="customer-profile-photo-img" src="${imageData}" alt="Your profile photo">`;
      window.showToast('Profile photo updated.', 'success');
    } catch (err) {
      window.showToast('Could not update photo: ' + err.message, 'error');
    } finally {
      changeButton.disabled = false;
      changeButton.innerHTML = originalText;
      photoInput.value = '';
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fullName = content.querySelector('#profile-full-name').value.trim();
    const phoneNumber = content.querySelector('#profile-phone').value.trim();
    const address = content.querySelector('#profile-address').value.trim();
    const currentPassword = content.querySelector('#profile-current-password').value;
    const newPassword = content.querySelector('#profile-new-password').value;
    const confirmPassword = content.querySelector('#profile-confirm-password').value;
    if (newPassword || confirmPassword) {
      if (!currentPassword) { window.showToast('Enter your current password to change it.', 'error'); return; }
      if (newPassword.length < 6) { window.showToast('New password must be at least 6 characters.', 'error'); return; }
      if (newPassword !== confirmPassword) { window.showToast('New password and confirmation do not match.', 'error'); return; }
    }
    const save = content.querySelector('.customer-profile-save');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      if (newPassword) {
        const credential = EmailAuthProvider.credential(user.email, currentPassword);
        await reauthenticateWithCredential(user, credential);
        await updatePassword(user, newPassword);
      }
      await updateDoc(doc(db, 'users', user.uid), { fullName, phoneNumber, address, updatedAt: serverTimestamp() });
      await updateProfile(user, { displayName: fullName });
      window.showToast(newPassword ? 'Profile and password updated.' : 'Profile updated.', 'success');
      loadCustomerProfileView();
    } catch (err) {
      window.showToast('Could not save profile: ' + err.message, 'error');
    } finally {
      save.disabled = false;
      save.textContent = 'Save Changes';
    }
  });
}

async function loadMyOrdersView() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
      <div class="customer-page-heading">
        <div><span class="customer-page-eyebrow">YOUR ACTIVITY</span><h2>My Orders &amp; Tracking</h2><p>Check your order progress, payment status, and delivery updates.</p></div>
        <button type="button" class="customer-refresh-btn" id="refresh-my-orders" aria-label="Refresh orders">↻ <span>Refresh</span></button>
      </div>
      <section class="customer-page-panel"><div id="orders-list"><div class="customer-loading-state"><span class="customer-loading-spinner"></span><span>Loading your orders…</span></div></div></section>`;
    const target = document.getElementById('orders-list');
    document.getElementById('refresh-my-orders')?.addEventListener('click', loadMyOrdersView);
    const money = value => `₱${Number(value || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const dateLabel = value => {
      try { const d = value?.toDate ? value.toDate() : (value ? new Date(value) : null); return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-PH', {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}) : 'Date unavailable'; }
      catch (_) { return 'Date unavailable'; }
    };
    const statusLabel = value => ({
      pending: 'Pending', accepted: 'Confirmed', processing: 'Processing', preparing: 'Processing',
      ready: 'Ready for Pickup', ready_for_pickup: 'Ready for Pickup', ready_for_dispatch: 'Ready for Dispatch',
      out_for_delivery: 'Out for Delivery', delivered: 'Delivered', completed: 'Completed',
      failed: 'Delivery Failed', cancelled: 'Cancelled', unpaid: 'Unpaid',
      pending_verification: 'Verifying Payment', paid: 'Paid', rejected: 'Payment Rejected',
      refund_pending: 'Refund Pending', refunded: 'Refunded', cod: 'Cash on Delivery', online: 'GCash', gcash: 'GCash'
    }[String(value || '').toLowerCase()] || String(value || 'Pending').replaceAll('_',' ').replace(/\b\w/g, c => c.toUpperCase()));
    const statusClass = value => {
      const v=String(value||'').toLowerCase();
      if (['paid','delivered','completed','approved'].includes(v)) return 'is-success';
      if (['cancelled','rejected','failed'].includes(v)) return 'is-danger';
      if (['pending_verification','out_for_delivery','processing','preparing','ready'].includes(v)) return 'is-info';
      return 'is-pending';
    };
    try {
      const snap = await getDocs(query(collection(db, 'orders'), where('customerId', '==', auth.currentUser.uid)));
      if (snap.empty) {
        target.innerHTML = `<div class="customer-empty-state"><span class="customer-empty-icon">▤</span><h3>No orders yet</h3><p>Your orders will appear here after you place your first order.</p><button type="button" class="btn-primary" id="go-to-catalog">Browse products</button></div>`;
        document.getElementById('go-to-catalog')?.addEventListener('click', () => document.querySelector('[data-target="catalog"]')?.click());
        return;
      }
      const orders = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b) => {
        const time = v => v?.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);
        return time(b.createdAt) - time(a.createdAt);
      });
      target.innerHTML = `<div class="customer-list-summary"><span>${orders.length} ${orders.length===1?'order':'orders'}</span><span>Most recent first</span></div><div class="customer-order-list">${orders.map(o => {
        const id=o.id;
        const items=Array.isArray(o.items)?o.items:[];
        const itemText=items.map(i=>`${escapeHtml(i.name || 'Product')} <span>× ${Math.max(0,Number(i.quantity)||0)}</span>`).join('');
        const type=String(o.type||o.orderType||'pickup').toLowerCase();
        const pay=String(o.paymentStatus||'unpaid').toLowerCase();
        const delivery=String(o.deliveryStatus||'pending').toLowerCase();
        const online=o.paymentMethod==='online' || String(o.paymentMethod||'').toLowerCase()==='gcash';
        let action='';
        if (delivery !== 'cancelled' && online && ['unpaid','pending_verification','rejected'].includes(pay)) action=`<button type="button" class="customer-order-action" onclick="window.openPaymentModal('${escapeAttr(id)}',${Number(o.totalAmount)||0})">${pay==='pending_verification'?'View payment proof':pay==='rejected'?'Resubmit payment proof':'Pay with GCash'} <span aria-hidden="true">→</span></button>`;
        else if (pay==='paid') action='<span class="customer-inline-confirm"><span>✓</span> Payment confirmed</span>';
        return `<article class="customer-order-card">
          <div class="customer-order-card-top"><div class="customer-order-id-wrap"><span class="customer-order-label">ORDER NUMBER</span><strong class="customer-order-id">#${escapeHtml(id.slice(0,8).toUpperCase())}</strong><small>${escapeHtml(dateLabel(o.createdAt))}</small></div><span class="customer-status-pill ${statusClass(delivery)}">${escapeHtml(statusLabel(delivery))}</span></div>
          <div class="customer-order-items">${itemText || '<span class="customer-muted">Order items</span>'}</div>
          <div class="customer-order-details"><div><span>Order type</span><strong>${type==='delivery'?'Delivery':'Pickup'}</strong></div><div><span>Payment</span><strong class="customer-status-text ${statusClass(pay)}">${escapeHtml(statusLabel(pay))}</strong></div><div><span>Total amount</span><strong class="customer-order-total">${money(o.totalAmount)}</strong></div></div>
          ${o.refundStatus === 'completed' ? `<div class="customer-order-card-action"><span class="customer-inline-confirm">✓ GCash refund completed</span>${o.refundProofImageData ? `<button type="button" class="customer-order-action" data-view-refund-proof="${escapeAttr(id)}">View refund proof</button>` : ''}</div>` : ''}
          ${action ? `<div class="customer-order-card-action">${action}</div>`:''}
          ${(['pending','accepted','preparing'].includes(delivery) || (type === 'pickup' && delivery === 'ready_for_pickup')) && pay === 'unpaid' ? `<div class="customer-order-card-action"><button type="button" class="customer-cancel-order-btn" data-cancel-order="${escapeAttr(id)}">Cancel order</button><small>Available before payment confirmation and dispatch.</small></div>` : ''}
          ${['paid','pending_verification'].includes(pay) && !['cancelled','completed','delivered','out_for_delivery'].includes(delivery) && !(delivery === 'ready_for_pickup' && type !== 'pickup') ? `<div class="customer-order-card-action">${o.cancellationRequestStatus === 'pending' ? '<span class="customer-inline-confirm">Cancellation request submitted — awaiting station review.</span>' : o.cancellationRequestStatus === 'rejected' ? '<span class="customer-muted">Cancellation request was not approved. Please contact the station for help.</span>' : `<button type="button" class="customer-cancel-order-btn" data-request-cancel="${escapeAttr(id)}">Request cancellation</button><small>${pay === 'pending_verification' ? 'Payment proof submitted; cancellation requires station review.' : 'Paid orders require station approval. A request does not guarantee a refund.'}</small>`}</div>` : ''}
        </article>`;
      }).join('')}</div>`;
      target.querySelectorAll('[data-view-refund-proof]').forEach(button => button.addEventListener('click', async () => {
        try {
          const proofOrder = orders.find(order => order.id === button.dataset.viewRefundProof);
          if (!proofOrder?.refundProofImageData) throw new Error('Refund proof is not available.');
          const modal = document.createElement('div'); modal.className = 'gcash-image-viewer';
          modal.innerHTML = '<button type="button" class="gcash-image-viewer-close" aria-label="Close refund proof">×</button><img alt="GCash refund proof">';
          modal.querySelector('img').src = proofOrder.refundProofImageData;
          const close = () => modal.remove(); modal.querySelector('button').onclick = close;
          modal.addEventListener('click', event => { if (event.target === modal) close(); }); document.body.appendChild(modal);
        } catch (error) { window.showToast(error.message || 'Could not open refund proof.', 'error'); }
      }));
      target.querySelectorAll('[data-request-cancel]').forEach(button => button.addEventListener('click', async () => {
        const orderId = button.dataset.requestCancel;
        const reason = window.prompt('Please enter the reason for requesting cancellation. The station will review your request; a refund is not automatic:');
        if (reason === null) return;
        if (!reason.trim()) { window.showToast('Please provide a cancellation reason.', 'error'); return; }
        button.disabled = true;
        try {
          const orderRef = doc(db, 'orders', orderId);
          const latest = await getDoc(orderRef);
          if (!latest.exists()) throw new Error('Order not found.');
          const current = latest.data();
          if (current.customerId !== auth.currentUser.uid || !['paid','pending_verification'].includes(String(current.paymentStatus || '').toLowerCase()) || (['cancelled','completed','delivered','out_for_delivery'].includes(String(current.deliveryStatus || 'pending').toLowerCase()) || (String(current.deliveryStatus || 'pending').toLowerCase() === 'ready_for_pickup' && String(current.type || current.orderType || '').toLowerCase() !== 'pickup')) || current.cancellationRequestStatus === 'pending') {
            throw new Error('This order is no longer eligible for a cancellation request. Please refresh your orders.');
          }
          await updateDoc(orderRef, { cancellationRequestStatus: 'pending', cancellationRequestReason: reason.trim().slice(0, 500), cancellationRequestedAt: serverTimestamp(), updatedAt: serverTimestamp() });
          window.showToast('Cancellation request sent to the station for review.', 'success');
          await loadMyOrdersView();
        } catch (err) {
          window.showToast('Could not submit cancellation request: ' + (err.message || 'Please try again.'), 'error');
          button.disabled = false;
        }
      }));
      target.querySelectorAll('[data-cancel-order]').forEach(button => button.addEventListener('click', async () => {
        const orderId = button.dataset.cancelOrder;
        const confirmed = window.confirm('Cancel this unpaid order? Pickup orders may be cancelled while waiting for pickup; completed handovers cannot be cancelled.');
        if (!confirmed) return;
        button.disabled = true;
        try {
          const orderRef = doc(db, 'orders', orderId);
          const latest = await getDoc(orderRef);
          if (!latest.exists()) throw new Error('Order not found.');
          const current = latest.data();
          if (current.customerId !== auth.currentUser.uid || current.paymentStatus !== 'unpaid' || !(['pending','accepted','preparing'].includes(String(current.deliveryStatus || 'pending').toLowerCase()) || (String(current.type || current.orderType || '').toLowerCase() === 'pickup' && String(current.deliveryStatus || 'pending').toLowerCase() === 'ready_for_pickup'))) {
            throw new Error('This order can no longer be cancelled. Please refresh your orders.');
          }
          await updateDoc(orderRef, { deliveryStatus: 'cancelled', updatedAt: serverTimestamp() });
          window.showToast('Order cancelled.', 'success');
          await loadMyOrdersView();
        } catch (err) {
          window.showToast('Could not cancel order: ' + (err.message || 'Please try again.'), 'error');
          button.disabled = false;
        }
      }));
    } catch(err) {
      target.innerHTML = `<div class="customer-inline-error"><strong>We couldn't load your orders.</strong><span>Please check your connection and try again.</span><button type="button" class="customer-refresh-btn" id="retry-my-orders">Try again</button></div>`;
      document.getElementById('retry-my-orders')?.addEventListener('click', loadMyOrdersView);
      console.error('loadMyOrdersView failed:', err);
    }
}

async function readPaymentImage(file, { preserveQr = false } = {}) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    if (file.size > 12 * 1024 * 1024) throw new Error('Image must be 12 MB or smaller.');
    const source = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the selected image.'));
        reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
        const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('This image could not be opened.')); img.src = source;
    });
    const maxDimension = preserveQr ? 900 : 1400;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is not supported in this browser.');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Keep QR codes lossless; payment screenshots are compressed to keep Firestore documents small.
    let result = canvas.toDataURL(preserveQr ? 'image/png' : 'image/jpeg', preserveQr ? undefined : 0.76);
    if (result.length > 680000 && !preserveQr) result = canvas.toDataURL('image/jpeg', 0.62);
    if (result.length > 680000) throw new Error(preserveQr ? 'QR image is too large after resizing. Please choose a smaller/clearer QR image.' : 'Screenshot is still too large. Please crop it or choose a smaller image.');
    return result;
}

window.openPaymentModal = async function(orderId, amount) {
    let settings = {};
    try { const snap = await getDoc(doc(db, 'paymentSettings', 'config')); if (snap.exists()) settings = snap.data(); } catch (e) { console.error(e); }
    const paymentRef = doc(db, 'payments', orderId);
    let existing = {};
    try { const snap = await getDoc(paymentRef); if (snap.exists()) existing = snap.data(); } catch (e) {}
    const modal = document.createElement('div');
    modal.className = 'loading-overlay gcash-customer-modal'; modal.id = 'payment-modal';
    modal.innerHTML = `<section class="gcash-customer-payment-card" role="dialog" aria-modal="true" aria-labelledby="gcash-customer-title">
      <header class="gcash-customer-payment-header"><div><span class="gcash-customer-eyebrow">SECURE PAYMENT SUBMISSION</span><h3 id="gcash-customer-title">Pay with GCash</h3><p>Scan the Owner's QR, pay the exact amount, then upload your payment screenshot.</p></div><button type="button" class="gcash-customer-close" id="close-payment" aria-label="Close payment window">×</button></header>
      <section class="gcash-payment-step gcash-payment-step-one" aria-labelledby="gcash-step-one-title"><div class="gcash-payment-step-heading"><span class="gcash-payment-step-number">1</span><div><h4 id="gcash-step-one-title">Pay using the Owner's GCash QR</h4><p>Scan the QR code and pay the exact amount shown below.</p></div></div>
      <div class="gcash-customer-recipient"><div class="gcash-customer-recipient-info"><span>${settings.gcashQrImage ? "SCAN THE OWNER\'S OFFICIAL QR CODE" : 'PAYMENT NOT CONFIGURED'}</span><div class="gcash-customer-order-summary"><div><span>Order number</span><strong class="gcash-order-number" title="${escapeHtml(orderId)}">#${escapeHtml(orderId.slice(0,8).toUpperCase())}</strong></div><div><span>Amount due</span><strong class="gcash-customer-due">₱${Number(amount).toFixed(2)}</strong></div></div></div>${settings.gcashQrImage ? `<button type="button" class="gcash-qr-open" id="open-gcash-qr" aria-label="View GCash QR code larger"><img src="${escapeAttr(settings.gcashQrImage)}" alt="Owner's GCash QR code"><span>Tap to enlarge</span></button>` : `<div class="gcash-qr-missing"><span aria-hidden="true">▦</span><strong>Owner has not uploaded the official QR code</strong><small>Do not send payment yet. Please contact the Owner.</small></div>`}</div>
      <p class="gcash-customer-instructions">${escapeHtml(settings.instructions || 'Send the exact amount. Your payment remains pending until the Owner verifies the transaction.')}</p></section>
      <form id="payment-proof-form" class="gcash-customer-proof-form"><div class="gcash-payment-step-heading gcash-payment-step-two-heading"><span class="gcash-payment-step-number">2</span><div><h4 id="gcash-step-two-title">Upload payment screenshot</h4><p>After paying, upload a clear screenshot so the Owner can verify it.</p></div></div><label class="gcash-upload-label" for="gcash-proof-file">Screenshot of successful payment <span>*</span></label><p class="gcash-upload-help">Choose an image from your device or take a photo. No reference number or transaction details needed.</p>
       <div id="gcash-proof-preview-wrap" class="gcash-proof-preview-wrap" hidden><img id="gcash-proof-preview" alt="Preview of your payment proof"><div><strong id="gcash-proof-filename">Selected screenshot</strong><small id="gcash-proof-size"></small><button type="button" class="gcash-proof-change" id="gcash-proof-change">Change image</button></div><button type="button" class="gcash-proof-remove" id="gcash-proof-remove" aria-label="Remove selected screenshot">×</button></div>
       <label class="gcash-proof-dropzone" for="gcash-proof-file" id="gcash-proof-dropzone"><input type="file" id="gcash-proof-file" accept="image/*" capture="environment" required><span class="gcash-proof-upload-icon" aria-hidden="true">↑</span><strong>Upload payment screenshot</strong><small>Tap to choose an image or take a photo · JPG, PNG</small></label>
       ${existing.rejectionReason ? `<div class="gcash-proof-rejection"><strong>Previous submission was rejected</strong><span>${escapeHtml(existing.rejectionReason)}</span>Please upload a new clear screenshot.</div>` : ''}
       <p class="gcash-proof-status" id="gcash-proof-status" role="status" aria-live="polite"></p><div class="gcash-proof-actions"><button type="submit" class="btn-primary" id="gcash-submit-proof" ${!settings.gcashQrImage || (existing.status === 'pending' && existing.proofImageData) ? 'disabled' : ''}>${!settings.gcashQrImage ? 'Payment QR unavailable' : (existing.status === 'pending' && existing.proofImageData ? 'Proof already submitted' : 'Submit Payment Proof')}</button><button type="button" class="btn-secondary" id="gcash-cancel-payment">Cancel</button></div>
       ${existing.status === 'pending' && existing.proofImageData ? '<p class="gcash-proof-pending-note">Your proof is awaiting Owner verification. You can close this window while waiting.</p>' : ''}
      </form></section>`;
    document.body.appendChild(modal);
    const fileInput = modal.querySelector('#gcash-proof-file');
    const previewWrap = modal.querySelector('#gcash-proof-preview-wrap');
    const dropzone = modal.querySelector('#gcash-proof-dropzone');
    const preview = modal.querySelector('#gcash-proof-preview');
    const submit = modal.querySelector('#gcash-submit-proof');
    const status = modal.querySelector('#gcash-proof-status');
    let selectedImage = null;
    const close = () => modal.remove();
    modal.querySelector('#close-payment').onclick = close;
    modal.querySelector('#gcash-cancel-payment').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('#open-gcash-qr')?.addEventListener('click', () => {
        const viewer = document.createElement('div'); viewer.className = 'gcash-image-viewer';
        viewer.innerHTML = `<button type="button" class="gcash-image-viewer-close" aria-label="Close QR preview">×</button><img alt="Owner's GCash QR code">`;
        viewer.querySelector('img').src = settings.gcashQrImage; viewer.querySelector('button').onclick = () => viewer.remove(); viewer.onclick = e => { if (e.target === viewer) viewer.remove(); };
        document.body.appendChild(viewer);
    });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]; if (!file) return;
        try {
            status.textContent = 'Preparing image…'; status.className = 'gcash-proof-status';
            selectedImage = await readPaymentImage(file);
            preview.src = selectedImage; previewWrap.hidden = false; dropzone.hidden = true;
            modal.querySelector('#gcash-proof-filename').textContent = file.name;
            modal.querySelector('#gcash-proof-size').textContent = `Optimized image · ${Math.round(selectedImage.length / 1024)} KB`;
            submit.disabled = false; status.textContent = 'Image ready. Please check that the payment details are readable.';
        } catch (err) { selectedImage = null; fileInput.value = ''; previewWrap.hidden = true; dropzone.hidden = false; status.textContent = err.message; status.className = 'gcash-proof-status is-error'; }
    });
    modal.querySelector('#gcash-proof-change').onclick = () => fileInput.click();
    modal.querySelector('#gcash-proof-remove').onclick = () => { selectedImage = null; fileInput.value = ''; previewWrap.hidden = true; dropzone.hidden = false; status.textContent = ''; submit.disabled = false; };
    if (existing.proofImageData) {
        preview.src = existing.proofImageData; previewWrap.hidden = false; dropzone.hidden = true;
        if (existing.status === 'pending') { fileInput.disabled = true; modal.querySelector('#gcash-proof-change').hidden = true; modal.querySelector('#gcash-proof-remove').hidden = true; }
        modal.querySelector('#gcash-proof-filename').textContent = existing.status === 'pending' ? 'Proof already submitted' : 'Previous proof';
        modal.querySelector('#gcash-proof-size').textContent = '';
    }
    modal.querySelector('#payment-proof-form').addEventListener('submit', async e => {
        e.preventDefault();
        if (existing.status === 'pending' && existing.proofImageData && !selectedImage) { window.showToast('Your proof is already awaiting verification.', 'error'); return; }
        if (!settings.gcashQrImage) { status.textContent = 'GCash payment is unavailable because the Owner has not uploaded the official QR code.'; status.className = 'gcash-proof-status is-error'; return; }
        if (!selectedImage) { status.textContent = 'Please choose a screenshot of the successful payment.'; status.className = 'gcash-proof-status is-error'; return; }
        submit.disabled = true; submit.textContent = 'Submitting…';
        try {
            const current = await getDoc(paymentRef);
            const orderSnap = await getDoc(doc(db, 'orders', orderId));
            const orderData = orderSnap.exists() ? orderSnap.data() : {};
            const data = { id: orderId, orderId, customerId: auth.currentUser.uid, customerName: String(orderData.customerName || ''), method: 'online', amount: Number(amount), senderName: '', referenceNumber: '', transactionDate: '', proofImageData: selectedImage, status: 'pending', rejectionReason: '', updatedAt: serverTimestamp() };
            if (current.exists()) await updateDoc(paymentRef, data); else await setDoc(paymentRef, { ...data, createdAt: serverTimestamp() });
            await updateDoc(doc(db, 'orders', orderId), { paymentStatus: 'pending_verification', updatedAt: serverTimestamp() });
            window.showToast('Payment proof submitted. Please wait for the Owner to verify it.', 'success'); close(); loadMyOrdersView();
        } catch (err) { status.textContent = 'Could not submit proof: ' + err.message; status.className = 'gcash-proof-status is-error'; submit.disabled = false; submit.textContent = 'Submit Payment Proof'; }
    });
};

async function loadReceiptsView() {
    const content = document.getElementById('app-content');
    content.innerHTML = `
      <div class="customer-page-heading"><div><span class="customer-page-eyebrow">PAYMENT HISTORY</span><h2>My Receipts</h2><p>Your official receipts and completed transactions in one place.</p></div><button type="button" class="customer-refresh-btn" id="refresh-my-receipts" aria-label="Refresh receipts">↻ <span>Refresh</span></button></div>
      <section class="customer-page-panel"><div id="receipts-list"><div class="customer-loading-state"><span class="customer-loading-spinner"></span><span>Loading your receipts…</span></div></div></section>`;
    const target = document.getElementById('receipts-list');
    document.getElementById('refresh-my-receipts')?.addEventListener('click', loadReceiptsView);
    const money = value => `₱${Number(value || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const dateLabel = value => {
      try { const d=value?.toDate?value.toDate():(value?new Date(value):null); return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : 'Date unavailable'; }
      catch (_) { return 'Date unavailable'; }
    };
    try {
      const snap = await getDocs(query(collection(db, 'receipts'), where('customerDetails.uid', '==', auth.currentUser.uid)));
      if (snap.empty) {
        target.innerHTML = `<div class="customer-empty-state"><span class="customer-empty-icon">▧</span><h3>No receipts yet</h3><p>Your official receipt will appear here once your payment is confirmed.</p><small>Need to check an order? Open My Orders &amp; Tracking.</small></div>`;
        return;
      }
      const receipts = snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
        const time=v=>v?.toDate?v.toDate().getTime():(v?new Date(v).getTime():0); return time(b.createdAt)-time(a.createdAt);
      });
      target.innerHTML = `<div class="customer-receipts-toolbar"><div><strong>${receipts.length} ${receipts.length===1?'receipt':'receipts'}</strong><span>Official records of your completed transactions</span></div><label class="customer-receipt-search"><span class="search-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input type="search" id="customer-receipt-filter" placeholder="Search receipt or order number" aria-label="Search receipts"></label></div><div class="customer-receipt-list" id="customer-receipt-list">${receipts.map(r=>{
        const receiptNo=String(r.receiptNumber||r.id||''); const orderId=String(r.orderId||'');
        return `<article class="customer-receipt-card" data-search="${escapeAttr((receiptNo+' '+orderId).toLowerCase())}"><div class="customer-receipt-icon" aria-hidden="true">▧</div><div class="customer-receipt-main"><span class="customer-order-label">OFFICIAL RECEIPT</span><strong>${escapeHtml(receiptNo||'Receipt')}</strong><small>Order #${escapeHtml(orderId.slice(0,8).toUpperCase()||'—')}</small><small>${escapeHtml(dateLabel(r.createdAt))}</small></div><div class="customer-receipt-amount"><span>Total paid</span><strong>${money(r.totalAmount)}</strong><span class="customer-status-pill is-success">✓ Confirmed</span></div></article>`;
      }).join('')}<div class="customer-receipt-no-results" id="customer-receipt-no-results" hidden>No receipts match your search.</div></div>`;
      const filter=document.getElementById('customer-receipt-filter');
      filter?.addEventListener('input',()=>{
        const q=filter.value.trim().toLowerCase(); let visible=0;
        document.querySelectorAll('#customer-receipt-list .customer-receipt-card').forEach(card=>{const match=card.dataset.search.includes(q);card.hidden=!match;if(match)visible++;});
        const noResults=document.getElementById('customer-receipt-no-results'); if(noResults)noResults.hidden=visible>0;
      });
    } catch(err) {
      target.innerHTML = `<div class="customer-inline-error"><strong>We couldn't load your receipts.</strong><span>Please check your connection and try again.</span><button type="button" class="customer-refresh-btn" id="retry-my-receipts">Try again</button></div>`;
      document.getElementById('retry-my-receipts')?.addEventListener('click', loadReceiptsView);
      console.error('loadReceiptsView failed:', err);
    }
}

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(value){return escapeHtml(value).replace(/`/g,'&#96;');}


// Prevent duplicate payment submissions for the same order while Firebase is responding.
window.openPaymentModal = window.guardAsyncAction((orderId) => `customer-payment-proof:${orderId}`, window.openPaymentModal);
