// Intercepteur de requêtes pour voler le JWT de l'application React/Vue
(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        let options = args[1] || {};
        
        // Si la requête a des headers
        if (options.headers) {
            let headers = new Headers(options.headers);
            let auth = headers.get('Authorization');
            if (auth && auth.startsWith('Bearer ')) {
                let token = auth.replace('Bearer ', '');
                // On sauvegarde le token pour l'extension
                sessionStorage.setItem('ubiflow_stolen_jwt', token);
                console.log("Ubiflow Auto-Poster: JWT Token intercepté avec succès !");
                sendTokenToApi(token);
            }
        }
        return originalFetch.apply(this, args);
    };

    // Intercepter aussi XMLHttpRequest au cas où
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function() {
        this._headers = {};
        origOpen.apply(this, arguments);
    };
    
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        this._headers[header] = value;
        if (header.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
            let token = value.replace('Bearer ', '');
            sessionStorage.setItem('ubiflow_stolen_jwt', token);
            console.log("Ubiflow Auto-Poster: JWT Token intercepté avec succès (XHR) !");
            sendTokenToApi(token);
        }
        origSetRequestHeader.apply(this, arguments);
    };

    function sendTokenToApi(token) {
        fetch('http://localhost:4000/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
        }).then(res => {
            if(res.ok) console.log("Ubiflow Auto-Poster: Token envoyé à l'API locale avec succès !");
        }).catch(err => {
            console.log("Ubiflow Auto-Poster: API locale non joignable. Assurez-vous qu'elle est lancée.", err);
        });
    }

    console.log("Ubiflow Auto-Poster: Intercepteur de JWT en place.");
})();
