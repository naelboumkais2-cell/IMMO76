// Clé partagée avec le serveur dashboard (env var MACHINE_API_KEY côté Render) — l'extension
// tourne en arrière-plan sans humain connecté au dashboard, donc pas de session possible ici ;
// depuis l'ajout de l'authentification obligatoire, cette clé est ce qui distingue "l'extension
// légitime" d'une requête anonyme sur les mêmes routes. Ce n'est pas un vrai secret (visible par
// quiconque inspecte le code de l'extension) mais suffit à empêcher un appel non voulu par un
// tiers qui ne connaît pas cette valeur.
const OTAREE_MACHINE_KEY = 'e91d41def27d5bf62e98b93d875829897072598f2d5c73410c57721920b9109b';

function generateTxtContent(lot) {
    let txt = "========== INFORMATIONS DU LOT ==========\n";
    txt += `ID Otaree : ${lot.id || 'Inconnu'}\n`;
    txt += `Numéro : ${lot.number || 'Inconnu'}\n`;
    txt += `Typologie : ${lot.typology || 'Inconnu'}\n`;
    txt += `Surface totale : ${lot.surface !== null ? lot.surface : 'Inconnu'} m²\n`;
    txt += `Surface terrasse : ${lot.terraceSurface !== null ? lot.terraceSurface : 'Inconnu'} m²\n`;
    txt += `Pièces : ${lot.roomsCount || 'Inconnu'}\n`;
    txt += `Étage : ${lot.floorLabel || 'Inconnu'}\n`;
    txt += `Exposition : ${(lot.exposures || []).join(', ')}\n\n`;

    let price = "Inconnu";
    if (lot.prices && lot.prices.length > 0) {
        price = lot.prices[0].price || "Inconnu";
    }

    txt += "========== PRIX & RENTABILITÉ ==========\n";
    txt += `Prix total : ${price} €\n`;
    txt += `Loi(s) : ${(lot.laws || []).join(', ')}\n`;

    if (lot.prices && lot.prices.length > 0) {
        const p = lot.prices[0];
        txt += `Rentabilité brute : ${p.profitability || 'Inconnu'} %\n`;
        txt += `Prix au m² : ${p.squareMeterPrice || 'Inconnu'} €/m²\n`;
        txt += `Loyer mensuel estimé : ${p.monthlyRent || 'Inconnu'} €\n`;
        if (p.infos && p.infos.includedFurnituresPrice) {
            txt += `Dont prix des meubles : ${p.infos.includedFurnituresPrice.price || 0} €\n`;
        }
    }
    return txt;
}

function getSafeFilename(name, defaultExt) {
    if (!name) return `document.${defaultExt}`;
    return name.replace(/[^a-zA-Z0-9.\-_ ]/g, "").trim();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SCRAPE_FINISHED_NATIVE') {
        const lots = request.data;
        const exportId = new Date().getTime();
        const exportFolder = `Lots_Otaree_Export_${exportId}`;
        const tabId = sender.tab ? sender.tab.id : null;

        const sendProgress = (msg, percent) => {
            // Update other extension components if any
            chrome.runtime.sendMessage({
                action: 'UPDATE_PROGRESS',
                message: msg,
                percent: percent
            }).catch(() => {});
            // Update the page content script
            if (tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'UPDATE_PROGRESS',
                    message: msg,
                    percent: percent
                }).catch(() => {});
            }
        };
        
        sendProgress(`Préparation des dossiers pour ${lots.length} lots...`, 50);

        let downloadQueue = [];

        // Etape 1: Exporter le JSON complet à la racine du dossier
        const jsonString = JSON.stringify(lots, null, 2);
        downloadQueue.push({
            url: "data:application/json;charset=utf-8," + encodeURIComponent(jsonString),
            filename: `${exportFolder}/otaree_full_extract_${exportId}.json`
        });

        // Etape 2: Préparer les fichiers de chaque lot
        for (let i = 0; i < lots.length; i++) {
            const lot = lots[i];
            const num = lot.number || "Inconnu";
            const id = lot.id || "Inconnu";
            const basePath = `${exportFolder}/Lot_${num}_${id}/`;

            // Fiche Info
            const txt = generateTxtContent(lot);
            downloadQueue.push({
                url: "data:text/plain;charset=utf-8," + encodeURIComponent(txt),
                filename: basePath + "fiche_infos.txt"
            });

            // Plan principal
            if (lot.plan && lot.plan.urls && lot.plan.urls.download) {
                const ext = (lot.plan.mimeType || "").includes("pdf") ? "pdf" : "jpg";
                downloadQueue.push({
                    url: lot.plan.urls.download,
                    filename: basePath + `Plan_${num}.${ext}`
                });
            }

            // Documents (PDFs, brochures, etc.)
            if (lot.documents && lot.documents.length > 0) {
                for (let d = 0; d < lot.documents.length; d++) {
                    const doc = lot.documents[d];
                    if (doc.file && doc.file.urls && doc.file.urls.download) {
                        const ext = (doc.file.mimeType || "").includes("pdf") ? "pdf" : "jpg";
                        // Utilise le nom d'origine ou le typeLabel, et ajoute l'index _1, _2 pour éviter tout écrasement !
                        const baseName = doc.typeLabel || (doc.file && doc.file.name ? doc.file.name.replace(/\.[^/.]+$/, "") : `Document`);
                        let label = getSafeFilename(`${baseName}_${d+1}`, ext);
                        if (!label.toLowerCase().endsWith("." + ext)) label += "." + ext;
                        
                        downloadQueue.push({
                            url: doc.file.urls.download,
                            filename: basePath + label
                        });
                    }
                }
            }

            // Images (Photos, etc.)
            if (lot.images && lot.images.length > 0) {
                for (let m = 0; m < lot.images.length; m++) {
                    const img = lot.images[m];
                    if (img.file && img.file.urls && img.file.urls.download) {
                        const ext = (img.file.mimeType || "").includes("pdf") ? "pdf" : "jpg";
                        const baseName = img.typeLabel || (img.file && img.file.name ? img.file.name.replace(/\.[^/.]+$/, "") : `Image`);
                        let label = getSafeFilename(`${baseName}_${m+1}`, ext);
                        if (!label.toLowerCase().endsWith("." + ext)) label += "." + ext;
                        
                        downloadQueue.push({
                            url: img.file.urls.download,
                            filename: basePath + label
                        });
                    }
                }
            }
        }

        // Execution de la queue de téléchargement
        let currentIdx = 0;
        
        function processNext() {
            if (currentIdx >= downloadQueue.length) {
                sendProgress(`Terminé ! ${lots.length} dossiers générés avec succès.`, 100);
                return;
            }

            // Mise à jour UI
            if (currentIdx % 5 === 0) {
                const percent = 50 + Math.round((currentIdx / downloadQueue.length) * 50);
                sendProgress(`Téléchargement des fichiers (${currentIdx}/${downloadQueue.length})...`, percent);
            }

            const item = downloadQueue[currentIdx];
            chrome.downloads.download({
                url: item.url,
                filename: item.filename,
                saveAs: false,
                conflictAction: "uniquify" // Au cas où, on uniquify toujours
            }, () => {
                if (chrome.runtime.lastError) {
                    console.warn("Download failed for", item.filename, chrome.runtime.lastError);
                }
                currentIdx++;
                setTimeout(processNext, 5);
            });
        }

        processNext();

        // La publication vers Ubiflow se fait uniquement via le Watcher de Ubiflow-Auto-API/
        // server.js (déclenché par l'apparition du dossier Lots_Otaree_Export_* ci-dessus) —
        // il fait un meilleur travail (ville/CP fiables, texte complet, toutes les photos) et
        // c'est lui qui a été durci en conditions réelles. Un appel direct à /api/publish
        // existait ici en parallèle ; retiré car il créait systématiquement un brouillon en
        // double pour chaque lot (aucune déduplication côté serveur entre les deux appels),
        // avec un contenu plus pauvre (pas de ville/CP connus, 5 photos max).

        // Copie best-effort vers le dashboard (supervision/pilotage multi-portail), en plus du
        // pipeline ci-dessus, jamais à la place. Si le dashboard ne tourne pas, échoue
        // silencieusement — n'affecte ni Downloads ni le Watcher/Ubiflow.
        fetch('https://immo-76.vercel.app/api/scraper/otaree-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Machine-Key': OTAREE_MACHINE_KEY },
            body: JSON.stringify({ url: request.searchUrl, lots: lots })
        }).catch(() => {});
    } else if (request.action === 'OTAREE_REFRESH_TOKEN') {
        // Capture indépendante du refresh_token Otaree, vers le dashboard — best-effort,
        // aucun impact sur le flux d'extraction/publication ci-dessus si le dashboard est
        // injoignable.
        fetch('https://immo-76.vercel.app/api/scraper/otaree-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Machine-Key': OTAREE_MACHINE_KEY },
            body: JSON.stringify({ refreshToken: request.refreshToken, device: request.device, instanceId: request.instanceId })
        }).catch(() => {});
    }

    return true;
});

// Déclenche le scraping lorsque l'utilisateur clique sur l'icône de l'extension
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => alert("Veuillez utiliser l'extension sur la page Otaree contenant la liste des lots.")
            });
        } catch (e) {}
        return;
    }

    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'START_SCRAPE' });
    } catch (err) {
        // Le content script n'est pas encore injecté (ex. page non rafraîchie)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            // Petit délai d'initialisation puis envoi du message
            setTimeout(async () => {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: 'START_SCRAPE' });
                } catch (err2) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (msg) => alert("Erreur : Impossible de démarrer l'extraction. " + msg),
                        args: [err2.message]
                    }).catch(() => {});
                }
            }, 150);
        } catch (scriptErr) {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (msg) => alert("Veuillez rafraîchir la page (F5) et réessayer. Erreur technique : " + msg),
                args: [scriptErr.message]
            }).catch(() => {});
        }
    }
});
