chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SEND_TOKEN_TO_API' && request.token) {
        // Envoi du token à notre API Node.js locale
        fetch('https://immo76-moteur-ia.vercel.app/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token: request.token, espaceLogin: request.espaceLogin || null })
        })
        .then(res => res.json())
        .then(data => {
            console.log('Token envoyé avec succès à l\'API locale:', data);
        })
        .catch(err => {
            console.error('Erreur: L\'API locale (https://immo76-moteur-ia.vercel.app) semble éteinte ou inaccessible.', err);
        });
    }
});
