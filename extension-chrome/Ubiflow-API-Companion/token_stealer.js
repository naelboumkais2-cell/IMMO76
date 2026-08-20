(function() {
    let interceptedToken = null;

    // Le JWT Ubiflow porte lui-même l'identifiant de l'espace (claim "username",
    // ex: "ag762216") — on le lit directement dedans plutôt que de le déduire de
    // l'URL ou d'un élément de page, qui pourraient changer sans prévenir.
    function decodeEspaceLogin(token) {
        try {
            const parts = token.split('.');
            if (parts.length < 2) return null;
            let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            const payload = JSON.parse(atob(b64));
            return payload.username || null;
        } catch (e) {
            return null;
        }
    }

    function sendToken(token) {
        if (token && token !== interceptedToken) {
            interceptedToken = token;
            const espaceLogin = decodeEspaceLogin(token);
            console.log("Ubiflow API Companion : Token JWT intercepté !", espaceLogin ? `(espace ${espaceLogin})` : '(espace non identifié)');
            window.postMessage({ source: 'ubiflow-spy', type: 'TOKEN_INTERCEPTED', token: token, espaceLogin: espaceLogin }, '*');
        }
    }

    // 1. Vérification dans l'URL (comme on le voit sur ta capture d'écran)
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const urlToken = urlParams.get('token');
        if (urlToken && urlToken.startsWith('eyJ')) {
            sendToken(urlToken);
        }
    } catch(e) {}

    // Interception des requêtes Fetch
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        let options = args[1] || {};

        if (options.headers) {
            try {
                let headers = new Headers(options.headers);
                let auth = headers.get('Authorization');
                if (auth && auth.startsWith('Bearer ')) {
                    sendToken(auth.replace('Bearer ', '').trim());
                }
            } catch(e) {}
        }
        return originalFetch.apply(this, args);
    };

    // Interception des requêtes XHR
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function() {
        this._headers = {};
        origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        this._headers[header] = value;
        if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
            sendToken(value.replace('Bearer ', '').trim());
        }
        origSetRequestHeader.apply(this, arguments);
    };

    // Vérification dans le localStorage (souvent utilisé par les apps modernes)
    try {
        const storages = [localStorage, sessionStorage];
        for (let s of storages) {
            for (let i = 0; i < s.length; i++) {
                const key = s.key(i);
                const item = s.getItem(key);
                if (item && typeof item === 'string' && item.includes('eyJ')) {
                    let token = item;
                    try {
                        const parsed = JSON.parse(item);
                        if (parsed.token) token = parsed.token;
                        else if (parsed.jwt) token = parsed.jwt;
                        else if (parsed.access_token) token = parsed.access_token;
                    } catch(e){}
                    
                    if (typeof token === 'string' && token.startsWith('eyJ')) {
                        sendToken(token);
                    }
                }
            }
        }
    } catch(e) {}
})();
