const axios = require('axios');

async function testPublish() {
    console.log("🚀 Lancement du test de publication automatique...");

    // Simulons des données extraites d'Otaree (ce qui sera envoyé par votre script final)
    const testData = {
        textContext: `
========== INFORMATIONS DU LOT ==========
ID Otaree : B813-TEST
Numéro : B813
Typologie : T2
Surface totale : 45.5 m²
Étage : 1
Prix total : 145000 €
Rentabilité brute : 4.5 %
Loyer mensuel estimé : 550 €
        `,
        base64Images: [] // Vous pourrez ajouter une image en base64 ici pour tester la vision IA
    };

    try {
        const response = await axios.post('http://localhost:4000/api/publish', testData);
        console.log("✅ Résultat de l'API :", response.data);
    } catch (error) {
        if (error.response) {
            console.error("❌ Erreur API :", error.response.data);
        } else {
            console.error("❌ Erreur de connexion : L'API est-elle lancée ?", error.message);
        }
    }
}

testPublish();
