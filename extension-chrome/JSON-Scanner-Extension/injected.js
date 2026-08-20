// injected.js
(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = args[0];
        const options = args[1];

        if (url && typeof url === 'string' && url.includes('traitement-envoi-annonce-advanced')) {
            if (options && options.body) {
                try {
                    const parsedBody = JSON.parse(options.body);
                    console.log("🔥 [JSON SCANNER] Requête interceptée :", parsedBody);

                    // Télécharger automatiquement le JSON intercepté
                    const blob = new Blob([JSON.stringify(parsedBody, null, 2)], { type: "application/json" });
                    const blobUrl = URL.createObjectURL(blob);

                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = `ubiflow_payload_${Date.now()}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                } catch(e) {
                    console.error("Erreur de parsing JSON", e);
                }
            }
        }
        return await originalFetch.apply(this, args);
    };

    const originalXHR = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        // Optionnel : on peut aussi intercepter XHR ici si besoin,
        // mais Ubiflow utilise généralement fetch pour les annonces.
        return originalXHR.apply(this, arguments);
    };

    console.log("✅ [JSON SCANNER] Injecté et prêt à capturer les requêtes !");
})();
