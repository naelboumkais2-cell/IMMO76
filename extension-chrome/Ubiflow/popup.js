document.addEventListener('DOMContentLoaded', async () => {
    // Configuration de PDF.js
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    }

    const folderInput = document.getElementById('folderInput');
    const fileStatus = document.getElementById('fileStatus');
    const processBtn = document.getElementById('processBtn');
    const logArea = document.getElementById('logArea');
    const logs = document.getElementById('logs');

    // Dictionnaire pour grouper les fichiers par nom de dossier
    let groupedFiles = {};

    const UBIFLOW_CONFIG = {
        annonceur_login: "ag762217",
        flux_code: "SAISIE_IMMO",
        contact_email: "cgalliot@plusimmo76.fr",
        contact_phone: "02 32 86 47 72",
        contact_address: "49 RUE JEANNE D ARC",
        contact_cp: "76000",
        contact_city: "ROUEN",
        contact_id: 146267
    };

    // Clé chargée depuis config.local.json (non commité, voir config.example.json) —
    // évite d'avoir un secret en clair dans un fichier suivi par Git.
    let OPENAI_API_KEY = null;
    try {
        const configResp = await fetch(chrome.runtime.getURL('config.local.json'));
        if (configResp.ok) {
            const config = await configResp.json();
            OPENAI_API_KEY = config.OPENAI_API_KEY || null;
        }
    } catch (e) {
        console.warn('config.local.json introuvable ou invalide.', e);
    }

    function addLog(msg, isBold = false) {
        logArea.classList.remove('hidden');
        const div = document.createElement('div');
        div.className = 'log-entry';
        if(isBold) {
            div.innerHTML = `<strong>> ${msg}</strong>`;
        } else {
            div.innerText = `> ${msg}`;
        }
        logs.appendChild(div);
        logs.scrollTop = logs.scrollHeight;
    }

    // Helper pour extraire le texte d'un PDF
    async function extractTextFromPDF(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async function() {
                try {
                    const typedarray = new Uint8Array(this.result);
                    const pdf = await pdfjsLib.getDocument({data: typedarray}).promise;
                    let fullText = "";
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map(item => item.str).join(' ');
                        fullText += pageText + "\n";
                    }
                    resolve(fullText);
                } catch (e) {
                    console.error("Erreur PDF:", e);
                    resolve("[Erreur de lecture PDF]");
                }
            };
            reader.onerror = () => resolve("[Erreur FileReader]");
            reader.readAsArrayBuffer(file);
        });
    }

    // Helper pour lire un fichier texte
    async function readTextFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve("");
            reader.readAsText(file);
        });
    }

    // Helper pour lire une image en Base64
    async function readImageFile(file) {
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    }

    folderInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (files.length === 0) return;
        
        fileStatus.innerText = "Regroupement des dossiers...";
        fileStatus.className = "status-text text-muted";
        processBtn.disabled = true;
        
        groupedFiles = {};
        
        // Regrouper par le dossier parent immédiat
        for (let file of files) {
            const name = file.name.toLowerCase();
            if (name.startsWith('.')) continue; // ignore hidden

            const pathParts = file.webkitRelativePath.split('/');
            // Le dossier parent direct est l'avant-dernier élément du chemin
            let folderName = "Racine";
            if (pathParts.length > 1) {
                folderName = pathParts[pathParts.length - 2];
            }

            if (!groupedFiles[folderName]) {
                groupedFiles[folderName] = [];
            }
            groupedFiles[folderName].push(file);
        }

        const nbFolders = Object.keys(groupedFiles).length;
        
        if (nbFolders > 0) {
            fileStatus.innerText = `Prêt ! (${nbFolders} dossier(s) détecté(s))`;
            fileStatus.className = "status-text text-success";
            processBtn.disabled = false;
        } else {
            fileStatus.innerText = "Erreur: Aucun dossier valide trouvé.";
            fileStatus.className = "status-text text-error";
            processBtn.disabled = true;
        }
    });

    processBtn.addEventListener('click', async () => {
        processBtn.disabled = true;
        logs.innerHTML = "";
        
        try {
            // 1. Récupération du token JWT (Une seule fois pour tout le traitement)
            addLog("Récupération de la session Ubiflow globale...");
            let jwtToken = await new Promise((resolve, reject) => {
                chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                    if (tabs.length === 0 || !tabs[0].url.includes("ubiflow.net")) {
                        reject(new Error("Vous devez être sur un onglet Ubiflow actif !"));
                        return;
                    }
                    chrome.tabs.sendMessage(tabs[0].id, { action: "get_ubiflow_token" }, function(response) {
                        if (chrome.runtime.lastError) {
                            reject(new Error("Erreur de com: " + chrome.runtime.lastError.message));
                        } else {
                            resolve(response ? response.token : null);
                        }
                    });
                });
            });

            if (!jwtToken) addLog("⚠️ Aucun JWT trouvé. On tente avec les cookies...");
            else addLog("✅ Clé de sécurité JWT récupérée.");

            if (!OPENAI_API_KEY) {
                throw new Error("Clé OpenAI manquante : crée extension-chrome/Ubiflow/config.local.json (voir config.example.json à côté).");
            }

            const folders = Object.keys(groupedFiles);
            addLog(`🚀 Démarrage du traitement de ${folders.length} dossier(s)...`, true);

            // Boucle de traitement par dossier
            for (let i = 0; i < folders.length; i++) {
                const folderName = folders[i];
                const folderFiles = groupedFiles[folderName];
                
                addLog(`\n--- TRAITEMENT DU DOSSIER : [${folderName}] (${i+1}/${folders.length}) ---`, true);
                
                let lotDataText = "";
                let lotImages = [];
                
                // Extraire le contenu du dossier
                for (let file of folderFiles) {
                    const name = file.name.toLowerCase();
                    if (name.endsWith('.txt')) {
                        lotDataText += `\n--- FICHIER: ${file.name} ---\n`;
                        lotDataText += await readTextFile(file);
                    } else if (name.endsWith('.pdf')) {
                        lotDataText += `\n--- FICHIER PDF: ${file.name} ---\n`;
                        lotDataText += await extractTextFromPDF(file);
                    } else if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
                        const b64 = await readImageFile(file);
                        if (b64) lotImages.push(b64);
                    }
                }

                if (!lotDataText && lotImages.length === 0) {
                    addLog(`⚠️ Dossier [${folderName}] ignoré car vide ou illisible.`);
                    continue;
                }

                // 2. Rédiger via OpenAI
                addLog("🧠 Analyse IA (gpt-4o) en cours...");
                let generatedData;
                try {
                    generatedData = await callOpenAI(lotDataText, lotImages);
                } catch (openAiError) {
                    addLog(`❌ Échec de l'IA pour [${folderName}]: ${openAiError.message}`);
                    continue; // Passe au dossier suivant
                }

                // 3. Construire le JSON Ubiflow
                const payload = buildUbiflowPayload(generatedData);

                // 4. Envoyer la requête Ubiflow
                addLog("🌐 Envoi de l'annonce à Ubiflow...");
                let headers = {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8"
                };
                if (jwtToken) {
                    headers["Authorization"] = "Bearer " + jwtToken;
                }

                try {
                    const response = await fetch("https://espace-client-backend.ubiflow.net/traitement-envoi-annonce-advanced?lang=fr", {
                        method: "POST",
                        headers: headers,
                        credentials: "include",
                        body: JSON.stringify(payload)
                    });

                    const data = await response.json();
                    
                    if (response.ok && data.type === "success") {
                        addLog(`✅ Succès pour [${folderName}] ! Annonce publiée (ID: ${data.ad.id})`);
                        
                        const linkEdit = `https://espace-client.ubiflow.net/posts/edit/${data.ad.id}`;
                        const linkView = `https://espace-client.ubiflow.net/posts/${data.ad.id}`;
                        
                        const linkDiv = document.createElement('div');
                        linkDiv.innerHTML = `
                            <a href="${linkEdit}" target="_blank" style="color: #60A5FA;">✏️ Lien Édition</a> | 
                            <a href="${linkView}" target="_blank" style="color: #60A5FA;">👁️ Lien Vue Globale</a>
                        `;
                        logs.appendChild(linkDiv);
                    } else {
                        addLog(`❌ Erreur Ubiflow pour [${folderName}]: ${JSON.stringify(data || "Inconnue")}`);
                    }
                } catch (fetchError) {
                    addLog(`❌ Erreur réseau Ubiflow pour [${folderName}]: ${fetchError.message}`);
                }
            }

            addLog("\n🎉 TOUS LES DOSSIERS ONT ÉTÉ TRAITÉS !", true);

        } catch (error) {
            addLog(`❌ Erreur critique globale: ${error.message}`);
        } finally {
            processBtn.disabled = false;
        }
    });

    async function callOpenAI(textContext, base64Images) {
        // Préparation du prompt textuel
        const systemPrompt = `Agis comme un expert immobilier de la loi Pinel et LMNP. Tu dois lire toutes les informations fournies (textes, documents extraits de PDF, ou plans en image) pour extraire les données d'un lot immobilier neuf.
Renvoie UNIQUEMENT un objet JSON strictement conforme à la structure suivante, sans aucun markdown ni texte autour :
{
  "titre": "Titre accrocheur et vendeur (max 60 chars)",
  "titre_alternatif": "Titre court (max 40 chars)",
  "texte_resume": "Phrase d'accroche très courte résumant l'opportunité",
  "texte": "OBLIGATOIRE : Commence le texte par un bloc <b>Taux de rémunération</b> en adaptant STRICTEMENT le contenu aux conditions de commission, d'honoraires ou de rémunération indiquées dans les données fournies par l'annonce (les montants, les pourcentages, et les conditions). Mets les chiffres importants en gras avec des balises <b>. S'il n'y a absolument aucune information de rémunération, n'affiche pas ce bloc. Ensuite, rédige une description très vendeuse et élégante en t'inspirant FORTEMENT de la structure suivante : 1) Introduction accrocheuse du bien (ex: 'Plusimmo vous invite à découvrir...'). 2) Détail de l'agencement (entrée, pièces de vie, extérieur). 3) Une section sur la localisation (transports, commerces, universités). 4) Les atouts du bien en liste à puces (normes RE2020/RT2012, aucun travaux à prévoir, frais de notaire réduits, garantie décennale, stationnement). 5) Appel à l'action final ('Contactez dès aujourd'hui Plusimmo...'). Utilise des retours à la ligne (\\\\n) pour aérer.",
  "reference": "Reference extraite du texte (ex: B813-0B538DFE1892)",
  "prix": "Le prix total (nombre entier, ex: 84200)",
  "surface": "La surface totale (nombre entier en dixièmes de m2, ex: pour 17.17m2 -> 177)",
  "pieces": "Nombre de pièces (nombre entier, ex: 1 si T1, 2 si T2)",
  "etage": "Étage (nombre entier, mettre 0 si RDC, ou estimer à 1 si inconnu)",
  "code_postal": "Code postal extrait (ex: 76000)",
  "ville": "Ville extraite (ex: Rouen)",
  "date_livraison": "Date de livraison/actabilité au format DD/MM/YYYY si présente, sinon la date du jour"
}`;

        // Construction du payload multimodal (Vision)
        let messageContent = [
            {
                "type": "text",
                "text": "Voici les données extraites :\n\n" + (textContext || "(Aucun texte, base-toi sur les images)")
            }
        ];

        // Limite à 5 images max pour ce lot spécifique
        const maxImages = Math.min(base64Images.length, 5);
        for (let i = 0; i < maxImages; i++) {
            messageContent.push({
                "type": "image_url",
                "image_url": { "url": base64Images[i] }
            });
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: messageContent }
                ],
                temperature: 0.7,
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`OpenAI HTTP Error: ${response.status} - ${errBody}`);
        }

        const data = await response.json();
        let content = data.choices[0].message.content;
        
        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(content);
    }

    function buildUbiflowPayload(aiData) {
        return {
            action: "saveDraft",
            universe: "IMMO",
            annonce: {
                communiquer_adresse_exacte: "oui",
                nbDiffusions: 0,
                typeOffre: "G",
                typeObjet: 3200,
                photos: [],
                contact_a_afficher: "",
                email_a_afficher: UBIFLOW_CONFIG.contact_email,
                telephone_a_afficher: UBIFLOW_CONFIG.contact_phone,
                telephone_mobile_a_afficher: "",
                adresse_contact_a_afficher: UBIFLOW_CONFIG.contact_address,
                code_postal_contact_a_afficher: UBIFLOW_CONFIG.contact_cp,
                ville_contact_a_afficher: UBIFLOW_CONFIG.contact_city,
                id_contact_a_afficher: UBIFLOW_CONFIG.contact_id,
                devise_iso_4217: "EUR",
                programme_neuf_nom: aiData.titre_alternatif || "Programme Neuf",
                residence_type: "services",
                texte_resume: aiData.texte_resume,
                reference: aiData.reference,
                titre: aiData.titre,
                titre_alternatif: aiData.titre_alternatif,
                localText: aiData.texte,
                texte: aiData.texte,
                prix_min: parseInt(aiData.prix) || 0,
                prix_max: parseInt(aiData.prix) || 0,
                taux_tva: "20",
                surface_min: parseInt(aiData.surface) || 0,
                surface_max: parseInt(aiData.surface) || 0,
                nombre_etages: parseInt(aiData.etage) || 1,
                nb_pieces_min: parseInt(aiData.pieces) || 1,
                nb_pieces_max: parseInt(aiData.pieces) || 1,
                nb_bien: 1,
                nb_biens_disponibles: 1,
                eco_quartier: "non",
                bioconstruction: "non",
                belle_vue: "oui",
                affichage_privilegie: "non",
                latitude: "49.4431",
                longitude: "1.0993",
                code_postal_reel: (aiData.code_postal && aiData.code_postal !== "00000" && !String(aiData.code_postal).toLowerCase().includes("inconnu")) ? String(aiData.code_postal) : "76000",
                ville_reelle: (aiData.ville && !String(aiData.ville).toLowerCase().includes("inconnu")) ? String(aiData.ville) : "Rouen",
                numero_voie: 1,
                type_voie: "rue",
                nom_voie: "Principale",
                date_commercialisation: aiData.date_livraison || new Date().toLocaleDateString('fr-FR'),
                travaux_en_cours: "oui",
                pour_habiter: "oui",
                offre_titre: aiData.titre_alternatif,
                offre_texte: aiData.texte_resume,
                offre_type: "Vente en l'état futur d'achèvement (VEFA) / LMNP",
                defisc_statut_lmnp: "oui"
            },
            flux: {
                code: UBIFLOW_CONFIG.flux_code
            },
            annonceur: {
                login: UBIFLOW_CONFIG.annonceur_login
            }
        };
    }
});
