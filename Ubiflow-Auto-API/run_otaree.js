const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function testPublishOtaree() {
    console.log("🚀 Lancement du test avec le lot Otaree...");

    const lotPath = '/Users/naelboumkais/Downloads/Lots_Otaree_Export_1786589066893';
    const jsonFile = path.join(lotPath, 'otaree_full_extract_1786589066893.json');

    if (!fs.existsSync(jsonFile)) {
        console.error("❌ Fichier JSON Otaree introuvable !");
        return;
    }

    const otareeData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const lotsArray = Array.isArray(otareeData) ? otareeData : [otareeData];
    
    for (const lot of lotsArray) {
        const number = lot.number || 'Inconnu';
        const lot_id = lot.id || 'Inconnu';
        const lotDir = path.join(lotPath, `Lot_${number}_${lot_id}`);
        
        const textContext = JSON.stringify(lot, null, 2);

        let lotImageData = [];
        if (fs.existsSync(lotDir)) {
            const searchImages = (dir) => {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    const fullPath = path.join(dir, item.name);
                    if (item.isDirectory()) {
                        searchImages(fullPath);
                    } else {
                        const ext = path.extname(item.name).toLowerCase();
                        if (['.jpg', '.jpeg', '.png'].includes(ext) && lotImageData.length < 20) {
                            const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
                            const b64Data = fs.readFileSync(fullPath, 'base64');
                            lotImageData.push({ 
                                name: item.name.toLowerCase(), 
                                data: `data:${mime};base64,${b64Data}` 
                            });
                        }
                    }
                }
            };
            
            console.log(`📸 Recherche d'images pour le lot ${number}...`);
            searchImages(lotDir);
        }
        
        lotImageData.sort((a, b) => {
            const aIsExt = a.name.includes('perspective') || a.name.includes('exterieur');
            const bIsExt = b.name.includes('perspective') || b.name.includes('exterieur');
            if (aIsExt && !bIsExt) return -1;
            if (!aIsExt && bIsExt) return 1;
            return a.name.localeCompare(b.name);
        });
        
        const lotImages = lotImageData.map(img => img.data);

        const testData = {
            textContext: textContext,
            base64Images: lotImages
        };

        try {
            console.log(`Envoi du lot ${number} à l'API (localhost:4000)...`);
            const response = await axios.post('http://localhost:4000/api/publish', testData);
            console.log(`✅ Résultat de l'API pour le lot ${number} :`, response.data);
        } catch (error) {
            if (error.response) {
                console.error(`❌ Erreur API pour le lot ${number} :`, error.response.data);
            } else {
                console.error(`❌ Erreur de connexion pour le lot ${number} :`, error.message);
            }
        }
    }
}

testPublishOtaree();
