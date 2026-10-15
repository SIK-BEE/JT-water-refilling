import { auth, db } from "./firebase-init.js";
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Translate Firebase/internal errors into clear, actionable messages for everyday users.
function friendlyAuthMessage(error, context = 'login') {
    const code = String(error?.code || '');
    const raw = String(error?.message || '').toLowerCase();
    if (code.includes('email-already-in-use') || raw.includes('email-already-in-use')) return 'An account already uses this email address. Sign in or use a different email.';
    if (code.includes('weak-password') || raw.includes('password should be at least')) return 'Your password is too short. Use at least 6 characters.';
    if (code.includes('invalid-email')) return 'This email address is invalid. Check the address and try again.';
    if (code.includes('missing-password')) return 'Enter your password to continue.';
    if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') || code.includes('invalid-login-credentials')) return 'The email and password do not match. Check your details and try again.';
    if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a few minutes before trying again.';
    if (code.includes('network-request-failed')) return 'Unable to connect. Check your internet connection and try again.';
    if (code.includes('operation-not-allowed')) return 'This sign-up method is not enabled. Please contact the administrator.';
    if (code.includes('requires-recent-login')) return 'For your security, sign in again before performing this action.';
    if (code.includes('permission-denied') || raw.includes('missing or insufficient permissions')) return 'This request was blocked by access permissions. Please contact the administrator.';
    if (context === 'register') return 'We could not create your account. Check your information and try again.';
    if (context === 'reset') return 'We could not send the password reset email. Check the email address and try again.';
    return 'Unable to sign in. Check your email and password, then try again.';
}


// Shared Install App and Share App actions available to every signed-in role.
let jtDeferredInstallPrompt = null;
let jtInstallModal = null;
window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    jtDeferredInstallPrompt = event;
    const installButton = document.getElementById('install-app-btn');
    if (installButton) installButton.classList.add('install-available');
});
window.addEventListener('appinstalled', () => {
    jtDeferredInstallPrompt = null;
    const installButton = document.getElementById('install-app-btn');
    if (installButton) installButton.classList.remove('install-available');
    syncJtInstallButton();
    closeJtInstallModal();
    if (typeof window.showToast === 'function') window.showToast('JT Water Refilling was installed successfully.', 'success');
});
function isJtAppInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches || window.navigator.standalone === true;
}
function syncJtInstallButton() {
    const button = document.getElementById('install-app-btn');
    if (!button) return;
    const installed = isJtAppInstalled();
    button.disabled = installed;
    button.setAttribute('aria-disabled', String(installed));
    button.title = installed ? 'Already installed on this device' : 'Install JT Water Refilling';
    button.classList.toggle('is-installed', installed);
    const label = button.querySelector('span:last-child');
    if (label) label.textContent = installed ? 'Already Installed' : 'Install App';
}
function closeJtInstallModal() {
    if (!jtInstallModal) return;
    jtInstallModal.classList.remove('is-open');
    jtInstallModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('jt-install-modal-open');
}
function openJtInstallModal() {
    if (!jtInstallModal) {
        jtInstallModal = document.createElement('div');
        jtInstallModal.className = 'jt-install-modal';
        jtInstallModal.id = 'jt-install-modal';
        jtInstallModal.setAttribute('aria-hidden', 'true');
        jtInstallModal.innerHTML = `
          <section class="jt-install-card" role="dialog" aria-modal="true" aria-labelledby="jt-install-title" aria-describedby="jt-install-description" tabindex="-1">
            <button class="jt-install-close" type="button" aria-label="Close install dialog">&times;</button>
            <div class="jt-install-app-icon"><img src="assets/JT_LOGO.png" alt="JT Water Refilling logo"></div>
            <div class="jt-modal-title-row"><span class="jt-modal-title-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v11m-4-4 4 4 4-4"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg></span><h2 id="jt-install-title">Install JT Water Refilling</h2></div>
            <p id="jt-install-description" class="jt-install-description">Add JT Water Refilling App to your device for easy access from your home screen.</p>
            <div class="jt-install-actions"><button class="jt-install-primary" type="button" data-jt-install-confirm>Install App</button><button class="jt-install-secondary" type="button" data-jt-install-later>Maybe later</button></div>
            <p class="jt-install-help" data-jt-install-help hidden></p>
          </section>`;
        document.body.appendChild(jtInstallModal);
        jtInstallModal.addEventListener('click', event => { if (event.target === jtInstallModal) closeJtInstallModal(); });
        jtInstallModal.querySelector('.jt-install-close').addEventListener('click', closeJtInstallModal);
        jtInstallModal.querySelector('[data-jt-install-later]').addEventListener('click', closeJtInstallModal);
        jtInstallModal.querySelector('[data-jt-install-confirm]').addEventListener('click', async () => {
            const help = jtInstallModal.querySelector('[data-jt-install-help]');
            const confirm = jtInstallModal.querySelector('[data-jt-install-confirm]');
            if (isJtAppInstalled()) {
                if (typeof window.showToast === 'function') window.showToast('JT Water Refilling is already installed.', 'info');
                closeJtInstallModal();
                return;
            }
            if (jtDeferredInstallPrompt) {
                const promptEvent = jtDeferredInstallPrompt;
                jtDeferredInstallPrompt = null;
                confirm.disabled = true;
                confirm.textContent = 'Opening install prompt…';
                try {
                    await promptEvent.prompt();
                    const choice = await promptEvent.userChoice;
                    if (choice && choice.outcome === 'accepted') closeJtInstallModal();
                    else {
                        confirm.disabled = false;
                        confirm.textContent = 'Try Install Again';
                        help.hidden = false;
                        help.textContent = 'Installation was not completed. You can try again or use your browser menu to install the app.';
                    }
                } catch (error) {
                    confirm.disabled = false;
                    confirm.textContent = 'Try Install Again';
                    help.hidden = false;
                    help.textContent = 'Your browser could not open the install prompt. Use the browser menu instructions below.';
                    showJtInstallInstructions(help);
                }
                return;
            }
            showJtInstallInstructions(help);
            confirm.textContent = 'Got It';
            confirm.onclick = () => closeJtInstallModal();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && jtInstallModal?.classList.contains('is-open')) closeJtInstallModal();
        });
    }
    if (isJtAppInstalled()) {
        const title = jtInstallModal.querySelector('#jt-install-title');
        const description = jtInstallModal.querySelector('#jt-install-description');
        const confirm = jtInstallModal.querySelector('[data-jt-install-confirm]');
        title.textContent = 'Already Installed';
        description.textContent = 'JT Water Refilling is already installed on this device. You can open it from your home screen or app list.';
        confirm.textContent = 'Done';
        confirm.onclick = closeJtInstallModal;
        
        jtInstallModal.querySelector('[data-jt-install-help]').hidden = true;
    } else {
        jtInstallModal.querySelector('#jt-install-title').textContent = 'Install JT Water Refilling';
        jtInstallModal.querySelector('#jt-install-description').textContent = 'Add JT Water Refilling App to your device for easy access from your home screen.';
        const confirm = jtInstallModal.querySelector('[data-jt-install-confirm]');
        confirm.disabled = false;
        confirm.textContent = 'Install App';
        confirm.onclick = null;
        
        const help = jtInstallModal.querySelector('[data-jt-install-help]');
        help.hidden = true; help.textContent = '';
    }
    jtInstallModal.classList.add('is-open');
    jtInstallModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('jt-install-modal-open');
    requestAnimationFrame(() => jtInstallModal?.querySelector('.jt-install-card')?.focus());
}
function showJtInstallInstructions(help) {
    const ua = navigator.userAgent || '';
    let steps = 'Open your browser menu (⋮ or Share), then choose “Install app” or “Add to Home Screen”.';
    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) {
        steps = 'In Safari, tap the Share button, scroll down, then choose “Add to Home Screen”.';
    } else if (/Android/i.test(ua)) {
        steps = 'In Chrome, tap the menu (⋮), then choose “Install app” or “Add to Home screen”.';
    } else if (/Edg/i.test(ua)) {
        steps = 'In Microsoft Edge, open Settings and more (⋯), then Apps > Install this site as an app.';
    } else if (/Chrome/i.test(ua)) {
        steps = 'In Chrome, open the menu (⋮) and choose “Install app” or “Save and share” > “Install page as app”.';
    }
    help.hidden = false;
    help.textContent = steps + ' If the option is unavailable, make sure you opened the site over HTTPS and try a supported browser.';
}
let jtShareModal = null;
function closeJtShareModal() {
    if (!jtShareModal) return;
    jtShareModal.classList.remove('is-open');
    jtShareModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('jt-share-modal-open');
}
function openJtShareModal() {
    if (!jtShareModal) {
        jtShareModal = document.createElement('div');
        jtShareModal.className = 'jt-share-modal';
        jtShareModal.setAttribute('aria-hidden', 'true');
        jtShareModal.innerHTML = `
          <section class="jt-share-card" role="dialog" aria-modal="true" aria-labelledby="jt-share-title" tabindex="-1">
            <button class="jt-share-close" type="button" aria-label="Close share dialog">&times;</button>
            <div class="jt-share-brand"><img src="assets/app-icon-192.png" alt="JT Water Refilling app icon"></div>
            <div class="jt-share-title-row"><span class="jt-modal-title-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.4M8.7 13.3l6.6 4.4"/></svg></span><h2 id="jt-share-title">Share app</h2></div>
            <p class="jt-share-description">Share JT Water Refilling App.</p>
            <div class="jt-share-options jt-share-icons" aria-label="Choose an app to share">
              <button type="button" data-share="messenger" aria-label="Share with Facebook Messenger" title="Facebook Messenger"><svg class="brand-svg messenger-svg" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="jtMessengerGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00C6FF"/><stop offset="1" stop-color="#7B2FF7"/></linearGradient></defs><circle cx="24" cy="24" r="23" fill="url(#jtMessengerGradient)"/><path fill="#fff" d="M24 9C15.7 9 9 15.2 9 23c0 4.2 1.9 7.9 5.1 10.3V39l5.2-2.9c1.5.4 3.1.7 4.7.7 8.3 0 15-6.2 15-13.8S32.3 9 24 9Zm1.6 18.6-4.2-4.5-8.1 4.5 8.9-9.4 4.3 4.5 8-4.5-8.9 9.4Z"/></svg></button>
              <button type="button" data-share="facebook" aria-label="Share with Facebook" title="Facebook"><svg class="brand-svg" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#1877F2"/><path fill="#fff" d="M27.3 40V26.2h4.6l.7-5.4h-5.3v-3.4c0-1.6.5-2.7 2.7-2.7h2.8v-4.8c-.5-.1-2.2-.2-4.2-.2-4.2 0-7.1 2.5-7.1 7.3v3.8h-4.7v5.4h4.7V40h5.8Z"/></svg></button>
              <button type="button" data-share="gmail" aria-label="Share with Gmail" title="Gmail"><svg class="brand-svg" viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="7" width="42" height="34" rx="8" fill="#fff" stroke="#E1E5E8"/><path d="M8 35V14l16 12L40 14v21" fill="none" stroke="#4285F4" stroke-width="5" stroke-linejoin="round"/><path d="M8 14l16 12 16-12" fill="none" stroke="#EA4335" stroke-width="5" stroke-linejoin="round"/><path d="M8 17v18" stroke="#34A853" stroke-width="5"/><path d="M40 17v18" stroke="#FBBC04" stroke-width="5"/></svg></button>
              <button type="button" data-share="whatsapp" aria-label="Share with WhatsApp" title="WhatsApp"><svg class="brand-svg" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="22" r="18" fill="#25D366"/><path fill="#fff" d="M14 34l1.6-5.3A13 13 0 1 1 21 33l-7 1Zm7.3-18.8c-.5-1.1-1-1.1-1.5-1.1h-1.2c-.4 0-1 .2-1.5.8-.5.6-1.9 1.9-1.9 4.5s2 5.2 2.3 5.6c.3.4 3.8 6.1 9.4 8.3 4.7 1.9 5.7 1.5 6.7 1.4 1-.1 3.2-1.3 3.7-2.6.5-1.3.5-2.4.3-2.6-.2-.2-.5-.4-1.1-.7l-3.5-1.7c-.5-.2-.9-.4-1.3.4-.4.7-1.5 1.7-1.9 2.1-.4.4-.7.5-1.3.2-.6-.3-2.5-.9-4.8-3-1.8-1.6-3-3.6-3.3-4.2-.3-.6 0-.9.3-1.2l.9-1.1c.3-.4.4-.7.6-1.1.2-.4.1-.8 0-1.1l-1.1-2.9Z"/></svg></button>
            </div>
          </section>`
        document.body.appendChild(jtShareModal);
        jtShareModal.addEventListener('click', event => { if (event.target === jtShareModal) closeJtShareModal(); });
        jtShareModal.querySelector('.jt-share-close').addEventListener('click', closeJtShareModal);
        jtShareModal.querySelectorAll('[data-share]').forEach(button => button.addEventListener('click', async () => {
            const url = window.location.href;
            const text = 'Share JT Water Refilling App.';
            const encodedUrl = encodeURIComponent(url);
            const encodedText = encodeURIComponent(text + ' ' + url);
            const action = button.dataset.share;
            if (action === 'copy') {
                try {
                    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(url);
                    else { const input = document.createElement('textarea'); input.value = url; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('copy failed'); }
                    if (typeof window.showToast === 'function') window.showToast('App link copied. You can paste it into any chat.', 'success');
                    closeJtShareModal();
                } catch (_) { window.prompt('Copy this app link:', url); }
                return;
            }
            let target = '';
            if (action === 'messenger') target = `https://www.facebook.com/dialog/send?link=${encodedUrl}&redirect_uri=${encodedUrl}`;
            if (action === 'facebook') target = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;
            if (action === 'gmail') target = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('JT Water Refilling')}&body=${encodedText}`;
            if (action === 'whatsapp') target = `https://wa.me/?text=${encodedText}`;
            if (target) window.open(target, '_blank', 'noopener,noreferrer');
        }));
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && jtShareModal?.classList.contains('is-open')) closeJtShareModal(); });
    }
    jtShareModal.classList.add('is-open');
    jtShareModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('jt-share-modal-open');
    requestAnimationFrame(() => jtShareModal?.querySelector('.jt-share-card')?.focus());
}

async function startJtInstallFromButton() {
    if (isJtAppInstalled()) {
        syncJtInstallButton();
        if (typeof window.showToast === 'function') window.showToast('JT Water Refilling is already installed.', 'info');
        return;
    }
    if (jtDeferredInstallPrompt) {
        const promptEvent = jtDeferredInstallPrompt;
        jtDeferredInstallPrompt = null;
        try {
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            if (choice && choice.outcome === 'accepted') {
                if (typeof window.showToast === 'function') window.showToast('JT Water Refilling is being installed.', 'success');
            }
        } catch (error) {
            openJtInstallModal();
        }
        return;
    }
    openJtInstallModal();
}

async function copyJtAppLink() {
    // Share action is intentionally one tap: copy the clean app URL and show a brief confirmation.
    const appUrl = new URL(window.location.href);
    appUrl.search = '';
    appUrl.hash = '';
    const link = appUrl.href;
    let copied = false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(link);
            copied = true;
        } else {
            const field = document.createElement('textarea');
            field.value = link;
            field.setAttribute('readonly', '');
            field.style.position = 'fixed';
            field.style.left = '-9999px';
            field.style.top = '0';
            document.body.appendChild(field);
            field.select();
            copied = document.execCommand('copy');
            field.remove();
        }
    } catch (_) {
        copied = false;
    }

    if (copied) {
        if (typeof window.showToast === 'function') {
            window.showToast('App link copied! You can now paste it into Messenger or any chat.', 'success');
        } else {
            let toast = document.getElementById('jt-copy-link-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'jt-copy-link-toast';
                toast.setAttribute('role', 'status');
                toast.setAttribute('aria-live', 'polite');
                Object.assign(toast.style, {
                    position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
                    zIndex: '99999', maxWidth: 'calc(100vw - 32px)', padding: '12px 16px',
                    borderRadius: '12px', background: '#173D46', color: '#fff',
                    font: '600 14px/1.4 system-ui, sans-serif', textAlign: 'center',
                    boxShadow: '0 8px 24px rgba(0,0,0,.22)'
                });
                document.body.appendChild(toast);
            }
            toast.textContent = 'App link copied! You can now paste it into Messenger or any chat.';
            toast.hidden = false;
            clearTimeout(window.__jtCopyToastTimer);
            window.__jtCopyToastTimer = setTimeout(() => { if (toast) toast.hidden = true; }, 2800);
        }
    } else {
        if (typeof window.showToast === 'function') {
            window.showToast('Could not copy the app link. Please copy it from the address bar.', 'error');
        } else {
            window.prompt('Copy the JT Water Refilling app link:', link);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Use one consistent set of outline icons across Customer, Staff, Driver, and Admin drawers.
    const nav = document.getElementById('sidebar-nav');
    const iconForLabel = label => {
        const t = String(label || '').toLowerCase();
        const paths = t.includes('catalog') || t.includes('product') ? '<path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 1.9-1.4L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="17" cy="20" r="1"/>'
            : t.includes('receipt') ? '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h4"/>'
            : t.includes('profile') || t.includes('account') || t.includes('customer') ? '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'
            : t.includes('delivery') || t.includes('driver') || t.includes('tracking') ? '<path d="M3 5h11v11H3zM14 9h4l3 3v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>'
            : t.includes('order') || t.includes('queue') ? '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>'
            : t.includes('payment') || t.includes('gcash') || t.includes('receipt') ? '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>'
            : t.includes('product') || t.includes('price') ? '<path d="M3 7 12 3l9 4-9 4-9-4Z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/>'
            : t.includes('overview') || t.includes('sales') || t.includes('dashboard') ? '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
            : t.includes('setting') ? '<circle cx="12" cy="12" r="3"/><path d="M19 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L13.6 3h-3.2L10 5.1a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.1h3.2l.4-2.1a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5Z"/>'
            : '<path d="M4 5h16v14H4zM8 9h8M8 13h8"/>';
        return `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">${paths}</svg>`;
    };
    const refreshNavIcons = () => nav?.querySelectorAll('.nav-link').forEach(link => {
        const icon = link.querySelector('.nav-icon');
        const label = link.querySelector('span:not(.nav-icon)')?.textContent || link.textContent;
        if (icon) icon.innerHTML = iconForLabel(label);
    });
    if (nav) {
        refreshNavIcons();
        new MutationObserver(refreshNavIcons).observe(nav, { childList: true, subtree: false });
    }

    const installButton = document.getElementById('install-app-btn');
    const shareButton = document.getElementById('share-app-btn');
    if (installButton) installButton.addEventListener('click', startJtInstallFromButton);
    syncJtInstallButton();
    window.addEventListener('pageshow', syncJtInstallButton);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncJtInstallButton(); });
    if (shareButton) shareButton.addEventListener('click', copyJtAppLink);

});

// Prevent the auth router from racing customer profile creation during registration.
let registrationInProgress = false;


// Shared UI helpers: accessible modals, toast notifications, sound preferences, and loading states.
window.isSoundEnabled = () => {
    try { return localStorage.getItem('jt-sounds-enabled') !== 'false'; }
    catch (_) { return true; }
};
window.playAppSound = function(type = 'success') {
    if (!window.isSoundEnabled()) return;
    const file = type === 'error' ? './sounds/error.wav' : './sounds/success.wav';
    try {
        const audio = new Audio(file);
        audio.volume = type === 'error' ? 0.5 : 0.55;
        audio.play().catch(() => {});
    } catch (_) {}
};
window.setButtonLoading = function(button, loading, loadingText = 'Please wait...') {
    if (!button) return;
    if (loading) {
        if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = `<span class=\"button-loading-label\">${String(loadingText).replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]))}</span>`;
    } else {
        button.disabled = false;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        if (button.dataset.originalHtml) { button.innerHTML = button.dataset.originalHtml; delete button.dataset.originalHtml; }
    }
};
window.showToast = function(message, type = 'info', duration = 4200) {
    let host = document.getElementById('toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        host.setAttribute('aria-live', 'polite');
        host.setAttribute('aria-atomic', 'false');
        document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    const messageNode = document.createElement('span');
    messageNode.textContent = String(message);
    const iconNode = document.createElement('span');
    iconNode.className = 'toast-icon';
    iconNode.textContent = icon;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', () => dismiss());
    toast.append(iconNode, messageNode, close);
    host.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    if (type === 'success' || type === 'error') window.playAppSound(type);
    let timer;
    const dismiss = () => {
        if (!toast.isConnected) return;
        clearTimeout(timer);
        toast.classList.remove('toast-visible');
        window.setTimeout(() => toast.remove(), 240);
    };
    timer = window.setTimeout(dismiss, duration);
    return dismiss;
};

window.showConfirmModal = function({
    title = 'Please confirm',
    message = 'Are you sure you want to continue?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false
} = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'app-modal-backdrop';
        overlay.innerHTML = `
            <section class="app-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title" aria-describedby="app-confirm-message">
                <div class="app-modal-symbol ${danger ? 'is-danger' : ''}">${danger ? '!' : '?'}</div>
                <h2 id="app-confirm-title"></h2>
                <p id="app-confirm-message"></p>
                <div class="app-modal-actions">
                    <button type="button" class="btn-secondary modal-cancel"></button>
                    <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'} modal-confirm"></button>
                </div>
            </section>`;
        overlay.querySelector('#app-confirm-title').textContent = title;
        overlay.querySelector('#app-confirm-message').textContent = message;
        overlay.querySelector('.modal-cancel').textContent = cancelText;
        overlay.querySelector('.modal-confirm').textContent = confirmText;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('modal-visible'));
        const cancelButton = overlay.querySelector('.modal-cancel');
        const confirmButton = overlay.querySelector('.modal-confirm');
        let finished = false;
        const finish = value => {
            if (finished) return;
            finished = true;
            document.removeEventListener('keydown', onKey);
            overlay.classList.remove('modal-visible');
            window.setTimeout(() => overlay.remove(), 180);
            resolve(value);
        };
        const onKey = event => {
            if (event.key === 'Escape') finish(false);
            if (event.key === 'Enter' && overlay.isConnected) finish(true);
        };
        cancelButton.addEventListener('click', () => finish(false));
        confirmButton.addEventListener('click', () => finish(true));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(false);
        });
        document.addEventListener('keydown', onKey);
        cancelButton.focus();
    });
};

window.showPromptModal = function({
    title = 'Additional details',
    message = 'Enter a reason (optional).',
    placeholder = 'Enter details...',
    initialValue = '',
    confirmText = 'Submit',
    cancelText = 'Cancel',
    danger = false
} = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'app-modal-backdrop';
        overlay.innerHTML = `
            <section class="app-confirm-modal app-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="app-prompt-title">
                <div class="app-modal-symbol ${danger ? 'is-danger' : ''}">${danger ? '!' : '✎'}</div>
                <h2 id="app-prompt-title"></h2>
                <p class="app-prompt-message"></p>
                <textarea class="app-prompt-input" rows="3" maxlength="500"></textarea>
                <div class="app-modal-actions">
                    <button type="button" class="btn-secondary modal-cancel"></button>
                    <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'} modal-confirm"></button>
                </div>
            </section>`;
        overlay.querySelector('#app-prompt-title').textContent = title;
        overlay.querySelector('.app-prompt-message').textContent = message;
        const input = overlay.querySelector('.app-prompt-input');
        input.placeholder = placeholder;
        input.value = initialValue;
        overlay.querySelector('.modal-cancel').textContent = cancelText;
        overlay.querySelector('.modal-confirm').textContent = confirmText;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('modal-visible'));
        let finished = false;
        const finish = value => {
            if (finished) return;
            finished = true;
            document.removeEventListener('keydown', onKey);
            overlay.classList.remove('modal-visible');
            window.setTimeout(() => overlay.remove(), 180);
            resolve(value);
        };
        const onKey = event => {
            if (event.key === 'Escape') finish(null);
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) finish(input.value.trim());
        };
        overlay.querySelector('.modal-cancel').addEventListener('click', () => finish(null));
        overlay.querySelector('.modal-confirm').addEventListener('click', () => finish(input.value.trim()));
        overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
        document.addEventListener('keydown', onKey);
        input.focus();
    });
};

function setupSoundPreferenceControl() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar || document.getElementById('sound-preference-toggle')) return;

    const section = document.createElement('div');
    section.className = 'drawer-sound-settings';
    section.innerHTML = `
        <div class="drawer-sound-copy">
            <span class="drawer-sound-title">Notification sounds</span>
            <span class="drawer-sound-description">Order and action alerts</span>
        </div>
        <button id="sound-preference-toggle" class="sound-switch" type="button"
            role="switch" aria-checked="true" aria-label="Toggle notification sounds">
            <span class="sound-switch-track"><span class="sound-switch-thumb"></span></span>
        </button>
    `;

    const toggle = section.querySelector('#sound-preference-toggle');
    const refresh = () => {
        const enabled = window.isSoundEnabled();
        toggle.setAttribute('aria-checked', String(enabled));
        toggle.setAttribute('aria-label', enabled ? 'Mute notification sounds' : 'Enable notification sounds');
        section.classList.toggle('sounds-disabled', !enabled);
    };

    toggle.addEventListener('click', () => {
        const currentlyEnabled = window.isSoundEnabled();
        try {
            localStorage.setItem('jt-sounds-enabled', currentlyEnabled ? 'false' : 'true');
        } catch (_) {}
        refresh();
        window.showToast(
            window.isSoundEnabled() ? 'Notification sounds enabled.' : 'Notification sounds muted.',
            'info'
        );
        // Do not play a sound when the user is turning sounds off.
        if (window.isSoundEnabled()) window.playAppSound('success');
    });

    sidebar.appendChild(section);
    refresh();
}

function startNewOrderNotifications(role) {
    if (!['admin', 'staff'].includes(role)) return;
    if (window.__jtOrderNotificationsUnsubscribe) {
        window.__jtOrderNotificationsUnsubscribe();
        window.__jtOrderNotificationsUnsubscribe = null;
    }
    let firstSnapshot = true;
    const knownOrderIds = new Set();
    window.__jtOrderNotificationsUnsubscribe = onSnapshot(collection(db, 'orders'), snapshot => {
        if (firstSnapshot) {
            snapshot.docs.forEach(item => knownOrderIds.add(item.id));
            firstSnapshot = false;
            return;
        }
        snapshot.docChanges().forEach(change => {
            if (change.type !== 'added' || knownOrderIds.has(change.doc.id)) return;
            knownOrderIds.add(change.doc.id);
            const order = change.doc.data() || {};
            const orderLabel = String(change.doc.id).slice(0, 8).toUpperCase();
            window.showToast(`New order received${order.customerName ? ` from ${order.customerName}` : ''}. Order #${orderLabel}`, 'info', 6000);
            // Shared helper respects the user's sound preference; browsers may require a prior gesture.
            window.playAppSound('success');
        });
    }, error => {
        // Notifications are optional; do not interrupt the dashboard if access is unavailable.
        console.warn('New-order notifications are unavailable:', error.message);
    });
}

// Global tab switch helper
window.switchAuthTab = function(tab) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const title = document.getElementById('auth-title');

    if (tab === 'login') {
        loginForm.style.display = 'block';
        registerForm.style.display = 'none';
        if (title) title.textContent = 'Login';
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
        if (title) title.textContent = 'Register';
    }
};

function showRegistrationPendingModal() {
    const overlay = document.createElement('div');
    overlay.className = 'app-modal-backdrop';
    overlay.innerHTML = `<section class="app-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="registration-pending-title">
      <div class="app-modal-symbol">✓</div>
      <h2 id="registration-pending-title">Request Sent!</h2>
      <p>Your registration has been submitted. Our team will review your name and contact details. You can log in after your account is approved.</p>
      <div class="app-modal-actions"><button type="button" class="btn-primary modal-confirm">Back to Login</button></div>
    </section>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('modal-visible'));
    const close = () => { overlay.classList.remove('modal-visible'); window.setTimeout(() => overlay.remove(), 180); window.switchAuthTab('login'); };
    overlay.querySelector('button').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

document.addEventListener('DOMContentLoaded', () => {
    setupSoundPreferenceControl();
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const logoutBtn = document.getElementById('logout-btn');
    const loginError = document.getElementById('login-error');
    const registerError = document.getElementById('register-error');
    const forgotPasswordBtn = document.getElementById('forgot-password-btn');
    const drawerToggle = document.getElementById('drawer-toggle');
    const drawerBackdrop = document.getElementById('drawer-backdrop');
    const mobileDrawerQuery = window.matchMedia('(max-width: 900px)');

    // Keep the backdrop's hidden attribute in sync with the drawer state.
    // Without this, the backdrop remains hidden in the HTML and cannot receive outside clicks.
    const closeDrawer = () => {
        document.body.classList.remove('drawer-open');
        if (drawerToggle) drawerToggle.setAttribute('aria-expanded', 'false');
        if (drawerBackdrop) drawerBackdrop.hidden = true;
    };

    if (drawerToggle) drawerToggle.addEventListener('click', () => {
        const isOpen = !document.body.classList.contains('drawer-open');
        document.body.classList.toggle('drawer-open', isOpen);
        drawerToggle.setAttribute('aria-expanded', String(isOpen));

        // Backdrop is only used on compact/mobile screens.
        if (drawerBackdrop) drawerBackdrop.hidden = !(isOpen && mobileDrawerQuery.matches);
    });

    // Clicking outside the drawer closes it on mobile only.
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => {
        if (mobileDrawerQuery.matches) closeDrawer();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && mobileDrawerQuery.matches) closeDrawer();
    });

    // Desktop keeps the drawer open when a navigation item is selected.
    // Mobile closes it after choosing a destination.
    document.getElementById('sidebar-nav')?.addEventListener('click', e => {
        if (e.target.closest('.nav-link') && mobileDrawerQuery.matches) closeDrawer();
    });

    // Ensure the correct backdrop state when the viewport crosses the breakpoint.
    const syncDrawerForViewport = () => {
        const isOpen = document.body.classList.contains('drawer-open');
        if (drawerBackdrop) drawerBackdrop.hidden = !(isOpen && mobileDrawerQuery.matches);
        if (drawerToggle) drawerToggle.setAttribute('aria-expanded', String(isOpen));
    };
    if (mobileDrawerQuery.addEventListener) {
        mobileDrawerQuery.addEventListener('change', syncDrawerForViewport);
    } else {
        mobileDrawerQuery.addListener(syncDrawerForViewport);
    }

    // Colorize status pills consistently without changing order/payment logic.
    const statusObserver = new MutationObserver(() => {
        document.querySelectorAll('#app-container .badge:not(#user-role-badge)').forEach(badge => {
            const value = badge.textContent.trim().toLowerCase().replace(/[ _-]+/g, ' ');
            badge.classList.remove('badge-success', 'badge-danger', 'badge-warning', 'badge-info', 'badge-neutral', 'badge-admin', 'badge-staff', 'badge-driver', 'badge-customer');
            if (/\b(admin|owner)\b/.test(value)) badge.classList.add('badge-admin');
            else if (/\bstaff\b/.test(value)) badge.classList.add('badge-staff');
            else if (/\bdriver\b/.test(value)) badge.classList.add('badge-driver');
            else if (/\bcustomer\b/.test(value)) badge.classList.add('badge-customer');
            else if (/failed|reject|declin|cancel|error|inactive|unpaid|overdue/.test(value)) badge.classList.add('badge-danger');
            else if (/accept|approved|complete|completed|success|paid|active|delivered|verified/.test(value)) badge.classList.add('badge-success');
            else if (/pending|preparing|out for delivery|ready for pickup/.test(value)) badge.classList.add('badge-warning');
            else if (/online|delivery|pickup|cod|out_for_delivery/.test(value)) badge.classList.add('badge-info');
            else badge.classList.add('badge-neutral');
        });
        document.querySelectorAll('#app-container button').forEach(button => {
            const label = button.textContent.trim().toLowerCase();
            button.classList.remove('btn-success', 'btn-danger', 'btn-warning');
            if (/approve|accept|confirm|complete|delivered|save|create account/.test(label)) button.classList.add('btn-success');
            else if (/reject|decline|failed|delete|deactivate|sign out|log out/.test(label)) button.classList.add('btn-danger');
        });
    });
    statusObserver.observe(document.getElementById('app-container'), { childList: true, subtree: true, characterData: true });

    // Firebase password reset (uses the email entered in the login form).
    if (forgotPasswordBtn) {
        forgotPasswordBtn.addEventListener('click', async () => {
            window.setButtonLoading(forgotPasswordBtn, true, 'Sending email…');
            loginError.textContent = '';
            loginError.classList.remove('success-msg');
            loginError.classList.add('error-msg');
            const emailInput = document.getElementById('login-email');
            const email = emailInput.value.trim();

            if (!email) {
                loginError.textContent = 'Enter your email address first, then tap Forgot Password?';
                emailInput.focus();
                return;
            }

            try {
                await sendPasswordResetEmail(auth, email);
                loginError.textContent = 'Password reset email sent. Please check your inbox.';
                loginError.classList.remove('error-msg');
                loginError.classList.add('success-msg');
            } catch (error) {
                loginError.classList.remove('success-msg');
                loginError.classList.add('error-msg');
                loginError.textContent = friendlyAuthMessage(error, 'reset');
                window.showToast(loginError.textContent, 'error');
            } finally { window.setButtonLoading(forgotPasswordBtn, false); }
        });
    }

    // Login Handler
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        loginError.classList.remove('success-msg');
        loginError.classList.add('error-msg');
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;

        const submitButton = loginForm.querySelector('button[type=\"submit\"]');
        window.setButtonLoading(submitButton, true, 'Signing in…');
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            loginError.textContent = friendlyAuthMessage(error, 'login');
            window.showToast(loginError.textContent, 'error');
        } finally { window.setButtonLoading(submitButton, false); }
    });

    // Customer Registration Handler (Strictly creates Customer role only)
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        registerError.textContent = '';
        const fullName = document.getElementById('reg-name').value;
        const email = document.getElementById('reg-email').value;
        const phoneNumber = document.getElementById('reg-phone').value.trim();
        const address = document.getElementById('reg-address').value.trim();
        const password = document.getElementById('reg-password').value;

        if (password.length < 6) {
            registerError.textContent = 'Your password is too short. Use at least 6 characters.';
            window.showToast(registerError.textContent, 'error');
            document.getElementById('reg-password').focus();
            return;
        }
        if (!document.getElementById('reg-email').checkValidity()) {
            registerError.textContent = 'This email address is invalid. Check the address and try again.';
            window.showToast(registerError.textContent, 'error');
            document.getElementById('reg-email').focus();
            return;
        }

        registrationInProgress = true;
        const submitButton = registerForm.querySelector('button[type=\"submit\"]');
        window.setButtonLoading(submitButton, true, 'Creating account…');
        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            await setDoc(doc(db, 'users', user.uid), {
                uid: user.uid,
                email,
                fullName,
                phoneNumber,
                address,
                role: 'customer',
                status: 'pending',
                createdAt: serverTimestamp(),
                isActive: true
            });

            // New customers must wait for Admin approval before entering the app.
            await signOut(auth);
            registerForm.reset();
            showRegistrationPendingModal();
        } catch (error) {
            // If profile creation fails after Firebase Auth succeeds, do not leave the
            // just-created account signed in without a profile/dashboard route.
            try { if (auth.currentUser) await signOut(auth); } catch (_) {}
            registerError.textContent = friendlyAuthMessage(error, 'register');
            window.showToast(registerError.textContent, 'error');
        } finally {
            registrationInProgress = false;
            window.setButtonLoading(submitButton, false);
        }
    });

    // Logout Handler
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            const confirmed = await window.showConfirmModal({
                title: 'Sign out?',
                message: 'Are you sure you want to sign out of JT Water Refilling?',
                confirmText: 'Sign Out',
                cancelText: 'Stay logged in',
                danger: true
            });
            if (!confirmed) return;
            window.setButtonLoading(logoutBtn, true, 'Signing out…');
            try {
                await signOut(auth);
                window.location.reload();
            } catch (error) {
                window.setButtonLoading(logoutBtn, false);
                window.showToast(error.message || 'Unable to sign out. Please try again.', 'error');
            }
        });
    }

    // Auth State Observer & Router
    onAuthStateChanged(auth, async (user) => {
        if (registrationInProgress) return;
        const authContainer = document.getElementById('auth-container');
        const appContainer = document.getElementById('app-container');
        
        if (user) {
            try {
                // Role is read from the protected Firestore profile (no Cloud Functions required).
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                let role = userDoc.exists() ? userDoc.data().role : null;
                if (userDoc.exists() && userDoc.data().isActive === false) {
                    throw new Error('This account is disabled. Please contact the Owner.');
                }

                if (!role) {
                    throw new Error('User role is not assigned. Please contact administrator.');
                }

                const profileData = userDoc.data();
                if (role === 'customer' && profileData.status && profileData.status !== 'approved') {
                    const message = profileData.status === 'rejected'
                        ? 'Your registration request was not approved. Please contact the store for assistance.'
                        : 'Your account is awaiting Admin approval. You can access your dashboard after approval.';
                    const loginErrorNode = document.getElementById('login-error');
                    if (loginErrorNode) {
                        loginErrorNode.textContent = message;
                        loginErrorNode.classList.add('error-msg');
                    }
                    await signOut(auth);
                    return;
                }

                authContainer.style.display = 'none';
                appContainer.style.display = 'block';

                document.getElementById('user-display-name').textContent = (userDoc.data().fullName || user.email);
                const roleBadge = document.getElementById('user-role-badge');
                roleBadge.textContent = role.toUpperCase();
                roleBadge.className = `badge badge-${role}`;
                // Customer accounts do not need a role label in the app header.
                roleBadge.hidden = role === 'customer';

                // Start optional live new-order notifications for Admin and Staff.
                startNewOrderNotifications(role);

                // Route to correct dashboard module
                loadDashboard(role);

            } catch (error) {
                console.error("Authorization error:", error);
                authContainer.style.display = 'flex';
                appContainer.style.display = 'none';
                const loginErrorNode = document.getElementById('login-error');
                if (loginErrorNode) loginErrorNode.textContent = error?.message || 'Could not verify your account. Please try again or contact the Owner.';
                try { await signOut(auth); } catch (_) {}
            }
        } else {
            if (window.__jtOrderNotificationsUnsubscribe) {
                window.__jtOrderNotificationsUnsubscribe();
                window.__jtOrderNotificationsUnsubscribe = null;
            }
            authContainer.style.display = 'flex';
            appContainer.style.display = 'none';
        }
    });
});

function loadDashboard(role) {
    const appContainer = document.getElementById('app-container');
    const authContainer = document.getElementById('auth-container');
    const loaders = {
        customer: () => import('./customer.js'),
        staff: () => import('./staff.js'),
        driver: () => import('./driver.js'),
        admin: () => import('./admin.js')
    };
    if (!loaders[role]) {
        const message = 'Unknown user role. Please contact the Owner.';
        const loginErrorNode = document.getElementById('login-error');
        if (loginErrorNode) loginErrorNode.textContent = message;
        window.showToast(message, 'error');
        signOut(auth).catch(() => {});
        return;
    }
    loaders[role]().then(module => module[
        role === 'customer' ? 'initCustomerDashboard' :
        role === 'staff' ? 'initStaffDashboard' :
        role === 'driver' ? 'initDriverDashboard' : 'initAdminDashboard'
    ]()).catch(error => {
        console.error('Dashboard startup failed:', error);
        if (appContainer) appContainer.style.display = 'none';
        if (authContainer) authContainer.style.display = 'flex';
        const loginErrorNode = document.getElementById('login-error');
        if (loginErrorNode) loginErrorNode.textContent = error?.message || 'The dashboard could not start. Check your connection and contact the Owner if the problem continues.';
        signOut(auth).catch(() => {});
    });
}


// Login password visibility toggle. This is UI-only and does not affect authentication.
const loginPasswordInput = document.getElementById('login-password');
const toggleLoginPasswordButton = document.getElementById('toggle-login-password');
if (loginPasswordInput && toggleLoginPasswordButton) {
    toggleLoginPasswordButton.addEventListener('click', () => {
        const showPassword = loginPasswordInput.type === 'password';
        loginPasswordInput.type = showPassword ? 'text' : 'password';
        toggleLoginPasswordButton.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
        toggleLoginPasswordButton.setAttribute('title', showPassword ? 'Hide password' : 'Show password');
        toggleLoginPasswordButton.setAttribute('aria-pressed', String(showPassword));
        toggleLoginPasswordButton.innerHTML = showPassword
            ? '<svg class="password-eye-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.2A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a16.7 16.7 0 01-3.1 3.9M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.5 10.5 0 004.1-.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg class="password-eye-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
    });
}
