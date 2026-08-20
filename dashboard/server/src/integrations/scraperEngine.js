// Intégration MOCKÉE du scraping (source réelle : Autari, via extension-chrome/Otaree).
//
// Usage réel visé (pas encore connecté) : l'utilisateur fait une recherche manuelle sur
// Autari avec des filtres qui varient à chaque fois, puis lance l'extension Otaree sur la
// page de résultats. L'extension a accès à l'URL de cette page au moment où elle scrape et
// l'enverra, avec les annonces trouvées, en un seul batch au dashboard. Il n'y a donc pas de
// "scraping global en continu" : chaque run est rattaché à une recherche précise (son URL).
//
// Contrat à respecter par la vraie implémentation future :
//   async function run(url?: string) -> { url: string, annonces: Array<AnnonceScrapee>, erreur: string|null }
//
//   - `url` est l'URL de la page de résultats Autari déjà scrapée par l'extension.
//     - si fournie : ce run est rattaché à la recherche existante identifiée par cette URL
//       (rescraping périodique ou manuel de la même recherche).
//     - si omise : nouvelle recherche. Le mock génère une URL factice pour simuler ce que
//       l'extension enverra réellement ; l'implémentation réelle recevra toujours une URL
//       (elle vient de l'extension, jamais saisie à la main dans le dashboard).
//
// AnnonceScrapee = {
//   external_id: string,   // identifiant stable côté source (utilisé pour dédupliquer)
//   reference: string|null,
//   titre: string,
//   ville: string|null,
//   code_postal: string|null,
//   type_bien: string|null, // ex: 'Studio', 'T1', 'T2', 'Maison'
//   surface: number|null,
//   prix: number|null,
//   raw_data: object,      // payload source brut, conservé pour traçabilité/debug
//   donnees_ia: object,    // même forme que le "aiData" réel (voir Ubiflow-Auto-API/server.js
//                          // buildUbiflowPayload) : texte, titre_alternatif, texte_resume,
//                          // dpe_conso/ges, nb_chambres, balcon, parking, exposition... —
//                          // certains champs valent null pour rester fidèle au vrai comportement
//                          // ("un champ n'est envoyé que s'il existe vraiment").
//   images: string[],      // data-URI factices (contenu sans importance, juste la forme)
// }
//
// donnees_ia/images sont là pour pouvoir tester la connexion à Hubiflow (voir
// hubiflowClientReel.js) avec des données de la bonne forme, sans attendre le vrai scraper
// Otaree — leur contenu reste aléatoire/mocké comme le reste.
//
// Quand la vraie implémentation sera prête (l'extension Otaree posera ses batches vers le
// dashboard), elle devra exposer exactement la même fonction run() avec la même forme de
// retour — aucune autre partie du code (orchestrator, routes, front) n'a besoin de changer.

const VILLES = ['Rouen', 'Le Havre', 'Amiens', 'Lille', 'Caen'];
const TYPES = ['Studio', 'T1', 'T2', 'T3'];
const ZONES = ['76000', '76600', '80000', '59000', '14000'];
const EXPOSITIONS = ['sud', 'sud-est', 'sud-ouest', 'est', 'ouest', null];

// 1x1 PNG transparent — juste pour tester que le champ "photos" du payload Hubiflow est bien
// formé (base64 + type), pas du vrai contenu visuel.
const IMAGE_FACTICE =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function genererDonneesIA({ titre, ville, codePostal, type, surface, prix }) {
    const nbPieces = { Studio: 1, T1: 1, T2: 2, T3: 3 }[type] ?? 1;
    const aBalcon = Math.random() < 0.5;
    const aParking = Math.random() < 0.4;
    const dpe = randomFrom(['A', 'B', 'C', 'D', 'E', null]);

    return {
        titre,
        titre_alternatif: titre.length > 40 ? titre.slice(0, 37) + '…' : titre,
        texte_resume: `${type} de ${surface} m² à ${ville} (données de test, générées par le mock du scraper).`,
        texte: `Découvrez ce ${type.toLowerCase()} de ${surface} m² situé à ${ville}.\n\nAnnonce de test générée par le scraper mocké du dashboard, pour vérifier la chaîne de publication vers Hubiflow — contenu sans rapport avec un vrai bien.\n\nPrix : ${prix} €`,
        prix,
        surface,
        pieces: nbPieces,
        ville,
        code_postal: codePostal,
        reference: `MOCK-${Math.floor(Math.random() * 100000)}`,
        nb_chambres: nbPieces > 1 ? nbPieces - 1 : null,
        nb_salles_d_eau: 1,
        nb_wc: Math.random() < 0.5 ? 1 : null,
        balcon: aBalcon,
        nb_balcons: aBalcon ? 1 : null,
        surface_balcon: aBalcon ? Math.round(2 + Math.random() * 6) : null,
        parking: aParking,
        nb_parkings: aParking ? 1 : null,
        exposition: randomFrom(EXPOSITIONS),
        dpe_conso: dpe,
        dpe_ges: dpe,
        proche_commerces: Math.random() < 0.5 ? true : null,
    };
}

function genererImagesFactices() {
    const n = 2 + Math.floor(Math.random() * 3); // 2 à 4
    return Array.from({ length: n }, () => IMAGE_FACTICE);
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let mockCounter = 1000;
let mockUrlCounter = 1;

function genererUrlFactice() {
    mockUrlCounter += 1;
    const type = randomFrom(TYPES).toLowerCase();
    const zone = randomFrom(ZONES);
    return `https://www.autari.fr/recherche?type=${type}&codePostal=${zone}&ref=${mockUrlCounter}`;
}

export async function run(url) {
    // Simule la latence réseau d'un vrai scraping.
    await sleep(400 + Math.random() * 400);

    const resolvedUrl = url || genererUrlFactice();

    // Simule un échec occasionnel (pour que la supervision ait quelque chose à montrer).
    if (Math.random() < 0.05) {
        return { url: resolvedUrl, annonces: [], erreur: 'Timeout de connexion à Autari (simulé)' };
    }

    const nbNouvelles = Math.floor(Math.random() * 4); // 0 à 3 nouvelles annonces par run
    const annonces = [];
    for (let i = 0; i < nbNouvelles; i++) {
        mockCounter += 1;
        const ville = randomFrom(VILLES);
        const type = randomFrom(TYPES);
        const surface = Math.round((15 + Math.random() * 40) * 10) / 10;
        const prix = Math.round((60000 + Math.random() * 120000) / 100) * 100;
        const titre = `${type} ${surface} m² à ${ville}`;
        const codePostal = '76000';
        annonces.push({
            external_id: `AUTARI-MOCK-${mockCounter}`,
            reference: `REF-${mockCounter}`,
            titre,
            ville,
            code_postal: codePostal,
            type_bien: type,
            surface,
            prix,
            raw_data: { source: 'mock', mockCounter, ville, type, surface, prix },
            donnees_ia: genererDonneesIA({ titre, ville, codePostal, type, surface, prix }),
            images: genererImagesFactices(),
        });
    }

    return { url: resolvedUrl, annonces, erreur: null };
}
