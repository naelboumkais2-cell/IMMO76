console.log("Ubiflow Auto-Poster: Content script chargé.");

// Injecter le script pour voler le JWT dans le contexte de la page
const script = document.createElement('script');
script.src = chrome.runtime.getURL('token_stealer.js');
script.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === "get_ubiflow_token") {
        console.log("Demande de token reçue.");
        // Récupérer le token volé par token_stealer.js
        let token = sessionStorage.getItem('ubiflow_stolen_jwt');
        
        // Si pas trouvé par le stealer, on cherche de manière standard au cas où
        if (!token) {
            for (let i = 0; i < localStorage.length; i++) {
                let key = localStorage.key(i);
                let value = localStorage.getItem(key);
                if (value && typeof value === 'string' && value.startsWith('eyJ')) {
                    token = value;
                    break;
                }
            }
        }
        
        sendResponse({ success: true, token: token });
        return true;
    }
});
