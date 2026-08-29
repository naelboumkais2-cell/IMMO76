import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { IconRadar, IconRefresh, IconAlert, IconChevronDown, IconSearch } from './icons.jsx';
import { Select } from './Select.jsx';
import { Overlay } from './Overlay.jsx';

const VILLE_DEBOUNCE_MS = 300;
const VILLE_MIN_CHARS = 2;

// --- Options des filtres Otaree ---
// Labels confirmés : typology/taxArea/annex (capture réelle du body "tout coché"), nature
// (sondage direct de l'API — champ natureLabel). Labels provisoires ("Statut 1", "Loi X"...)
// pour les champs où seul le code numérique est connu — à corriger dès qu'on a confirmé le
// mapping exact, sans toucher au reste du composant (juste ces tableaux).
const TYPOLOGY_OPTIONS = [
    { value: 'studio', label: 'Studio' },
    { value: 'T1', label: 'T1' },
    { value: 'T2', label: 'T2' },
    { value: 'T3', label: 'T3' },
    { value: 'T4', label: 'T4' },
    { value: 'T5', label: 'T5' },
    { value: 'room', label: 'Chambre' },
];

// Confirmé par sondage direct de l'API (champ natureLabel présent dans la réponse de
// properties.jsonld pour chaque valeur testée individuellement) — plus provisoire.
const NATURE_OPTIONS = [
    { value: 1, label: 'Appartement' },
    { value: 2, label: 'Maison' },
    { value: 3, label: 'Immeuble' },
    { value: 4, label: 'Local commercial' },
    { value: 5, label: 'Bureau' },
    { value: 6, label: 'Terrain à bâtir' },
];

const STATUS_OPTIONS = [
    { value: 1, label: 'Statut 1' },
    { value: 2, label: 'Statut 2' },
];

const EXPOSURE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: `Exposition ${v}` }));

const FLOOR_OPTIONS = [
    { value: 0, label: 'RDC' },
    { value: 1, label: '1er étage' },
    { value: 2, label: '2e étage' },
    { value: 3, label: '3e étage' },
    { value: 4, label: '4e étage' },
    { value: 5, label: '5e étage' },
    { value: 1000, label: 'Étage 1000 (?)' },
    { value: 2000, label: 'Étage 2000 (?)' },
];

// Un seul libellé confirmé pour l'instant (2 = LMNP, sondage direct : coché seul dans le
// formulaire "Dispositif" au moment de la capture) — pas un 10e code parmi les 9 déjà présents,
// à ajouter en plus, les 9 autres restent provisoires ("Loi X").
const LAW_OPTIONS = [
    { value: 2, label: 'LMNP' },
    ...[41, 29, 38, 39, 11, 10, 8, 36, 21].map((v) => ({ value: v, label: `Loi ${v}` })),
];

// Confirmés par sondage direct (developer id -> nom lu dans program.developer.name des
// résultats retournés pour chaque id testé individuellement).
const DEVELOPER_OPTIONS = [
    { value: '/developers/3022d387a2e6', label: 'CELAVi pierre' },
    { value: '/developers/ab3f89e93847', label: 'Pierre & Sens' },
    { value: '/developers/dc7ffc55ea78', label: 'Consultim' },
    { value: '/developers/3d765184da1e', label: 'Pierre Loyers Conseil' },
];

const TAX_AREA_OPTIONS = ['A', 'A BIS', 'B1', 'B2', 'C', 'DOM'].map((v) => ({ value: v, label: v }));

const ANNEX_OPTIONS = [
    'GARAGE',
    'PARKING',
    'GARAGE DOUBLE',
    'PARKING DOUBLE',
    'CAVE',
    'CELLIER',
    'ABRI',
    'CASIER À SKI',
    'ROOFTOP',
    'PLACE MOTO',
    'LOCAL',
    'AUTRE',
].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }));

// Construit createdAfter au même format que la capture réelle (ISO + offset local), sans
// dépendre d'un fuseau horaire codé en dur.
function toOtareeDateString(dateStr) {
    if (!dateStr) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    const tzOffsetMin = -d.getTimezoneOffset();
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(tzOffsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${dateStr}T00:00:00.000${sign}${hh}:${mm}`;
}

function labelsPour(options, valeurs) {
    return valeurs.map((v) => options.find((o) => o.value === v)?.label ?? v);
}

// Résumé lisible construit à partir des mêmes filtres affichés dans le formulaire — affiché à la
// place de l'URL encodée (illisible) pour les recherches sans nom personnalisé.
function construireResumeFiltres({ villeSelectionnee, maxPrice, typologie, nature, statut, loi, promoteur }) {
    const parts = [];
    if (maxPrice.trim()) parts.push(`Prix max ${Number(maxPrice.trim()).toLocaleString('fr-FR')}€`);
    if (villeSelectionnee) parts.push(villeSelectionnee.name);
    if (typologie.length) parts.push(typologie.join('/'));
    if (nature.length) parts.push(labelsPour(NATURE_OPTIONS, nature).join('/'));
    if (statut.length) parts.push(labelsPour(STATUS_OPTIONS, statut).join('/'));
    if (loi.length) parts.push(labelsPour(LAW_OPTIONS, loi).join('/'));
    if (promoteur.length) parts.push(labelsPour(DEVELOPER_OPTIONS, promoteur).join('/'));
    return parts.length ? parts.join(', ') : 'Recherche sans filtre';
}

const OPTIONS_FREQUENCE = [
    { value: '', label: 'Manuel uniquement' },
    { value: '15', label: 'Toutes les 15 min' },
    { value: '30', label: 'Toutes les 30 min' },
    { value: '60', label: 'Toutes les heures' },
    { value: '180', label: 'Toutes les 3 heures' },
    { value: '1440', label: 'Une fois par jour' },
];

export function ScraperControl() {
    // 'accueil' : grande barre de recherche façon Google, rien d'autre — toujours affichée en
    // dessous. 'filtres' pilote l'ouverture de l'Overlay fullscreen (formulaire complet : ville +
    // tous les filtres + filtres avancés en bas) qui survole l'accueil, fond flouté (voir
    // Overlay.jsx pour l'animation d'entrée/sortie, gérée là-bas). ScraperControl lui-même ne
    // démonte jamais rien : le formulaire garde son state (recherche en cours, filtres en
    // saisie...) que l'Overlay soit ouvert ou fermé, seul l'affichage change.
    const [vue, setVue] = useState('accueil');

    const [nomRecherche, setNomRecherche] = useState('');
    const [villeQuery, setVilleQuery] = useState('');
    const [villeSuggestions, setVilleSuggestions] = useState([]);
    const [villeSelectionnee, setVilleSelectionnee] = useState(null);
    const [suggestionsOuvertes, setSuggestionsOuvertes] = useState(false);
    const [chargementSuggestions, setChargementSuggestions] = useState(false);
    const [maxPrice, setMaxPrice] = useState('');
    const [typologie, setTypologie] = useState([]);
    const [nature, setNature] = useState([]);
    const [statut, setStatut] = useState([]);
    const [minSurface, setMinSurface] = useState('');
    const [filtresAvancesOuverts, setFiltresAvancesOuverts] = useState(false);
    const [exposition, setExposition] = useState([]);
    const [etage, setEtage] = useState([]);
    const [loi, setLoi] = useState([]);
    const [promoteur, setPromoteur] = useState([]);
    const [zoneFiscale, setZoneFiscale] = useState([]);
    const [dependances, setDependances] = useState([]);
    const [rentabiliteMin, setRentabiliteMin] = useState('');
    const [commissionMin, setCommissionMin] = useState('');
    const [ajouteApres, setAjouteApres] = useState('');
    const [numeroBien, setNumeroBien] = useState('');
    const [surfaceDependancesMin, setSurfaceDependancesMin] = useState('');
    const [rechercheOtareeEnCours, setRechercheOtareeEnCours] = useState(false);
    const [comptageEnCours, setComptageEnCours] = useState(false);
    const [comptageOtaree, setComptageOtaree] = useState(null);
    const [autoPublishStatus, setAutoPublishStatus] = useState(null);
    const [annulationDemandee, setAnnulationDemandee] = useState(false);
    const [resultatOtaree, setResultatOtaree] = useState(null);
    const [erreurOtaree, setErreurOtaree] = useState(null);
    // Préférence globale du dashboard, pas par recherche — persistée pour survivre au
    // rechargement de page. Désactivée par défaut : comportement "zéro clic" inchangé (publie
    // immédiatement en utilisant le routage automatique et le mode par défaut de chaque portail).
    const [demanderConfirmation, setDemanderConfirmation] = useState(
        () => localStorage.getItem('demanderConfirmationAvantEnvoi') === '1'
    );
    const [confirmationEnAttente, setConfirmationEnAttente] = useState(null);
    const [confirmationEnCours, setConfirmationEnCours] = useState(false);
    const [photosEnErreur, setPhotosEnErreur] = useState(() => new Set());
    // Ids des lots cochés sur l'écran de confirmation — tous cochés par défaut à l'ouverture,
    // décochables un par un avant d'envoyer (mauvais prix, mauvaise ville, doublon visible...).
    const [lotsSelectionnes, setLotsSelectionnes] = useState(() => new Set());
    // Choix des portails de publication + mode, sur l'écran de confirmation — un seul choix pour
    // tout le lot de candidats confirmés (pas par lot individuel). Map portailId -> { publier,
    // mode }, initialisée une seule fois à l'ouverture de la confirmation (voir
    // onLancerRechercheOtaree) à partir de ce que les règles de routage auraient résolu ; ensuite
    // entièrement sous contrôle de l'utilisateur, jamais recalculée automatiquement (pour ne pas
    // écraser une modification volontaire au fil de la sélection/désélection des lots).
    const [portailsChoix, setPortailsChoix] = useState(() => new Map());
    // Référence LMNP par lot ({Initiales}-{VILLE}-{n°lot}, voir referenceGenerator.js) —
    // pré-remplie automatiquement quand le lot est LMNP avec un promoteur reconnu, vide sinon
    // (mandat direct, promoteur inconnu...). Toujours corrigible à la main : filet de sécurité en
    // cas de mauvaise classification, voir Map lotId -> string.
    const [referencesEditees, setReferencesEditees] = useState(() => new Map());
    // Doublons Hubiflow potentiels par lot (Map lotId -> [{titre, prix, portailNom, lien}]) —
    // uniquement à la demande (bouton "Vérifier les doublons"), jamais automatique : sur un run
    // de 40-80+ lots, lancer ça systématiquement à l'ouverture ferait 2 appels Hubiflow par lot
    // d'un coup, avec le même risque de rythme de requêtes excessif qui avait déjà déclenché la
    // protection Cloudflare sur notre propre hébergement (voir dépenses/monitoring).
    const [doublonsTrouves, setDoublonsTrouves] = useState(() => new Map());
    const [verifDoublonsEnCours, setVerifDoublonsEnCours] = useState(false);
    const [erreurDoublons, setErreurDoublons] = useState(null);
    // Détail d'un lot cliqué sur l'écran de confirmation — panneau imbriqué au-dessus de la
    // confirmation, purement présentationnel : ne touche jamais lotsSelectionnes ni confirmationEnAttente.
    const [lotDetailId, setLotDetailId] = useState(null);
    const [lotDetail, setLotDetail] = useState(null);
    const [lotDetailEnCours, setLotDetailEnCours] = useState(false);
    const [lotDetailErreur, setLotDetailErreur] = useState(null);
    // Panneau plein écran de la progression auto-publish — purement présentationnel (voir
    // Overlay.jsx) : le fermer ("Continuer en arrière-plan") ne touche jamais autoPublishStatus
    // ni ne déclenche d'annulation, le run continue exactement pareil en arrière-plan.
    const [panneauProgressionOuvert, setPanneauProgressionOuvert] = useState(false);
    const dernierRunOuvertRef = useRef(null);

    useEffect(() => {
        localStorage.setItem('demanderConfirmationAvantEnvoi', demanderConfirmation ? '1' : '0');
    }, [demanderConfirmation]);

    // Ouvre automatiquement le panneau plein écran au démarrage réel d'un run (autoPublishStatus
    // passe à enCours) — une seule fois par recherche (suivi par rechercheId), pour ne pas le
    // rouvrir tout seul après un "Continuer en arrière-plan" volontaire sur ce même run.
    useEffect(() => {
        if (autoPublishStatus?.enCours && autoPublishStatus.rechercheId !== dernierRunOuvertRef.current) {
            dernierRunOuvertRef.current = autoPublishStatus.rechercheId;
            setPanneauProgressionOuvert(true);
        }
    }, [autoPublishStatus]);

    // Autocomplétion ville : debounce + minimum de caractères, pour ne pas spammer l'API à
    // chaque frappe (observé dans une vraie capture réseau Otaree).
    useEffect(() => {
        if (villeSelectionnee && villeQuery === villeSelectionnee.name) return; // rien à refaire après sélection
        if (villeQuery.trim().length < VILLE_MIN_CHARS) {
            setVilleSuggestions([]);
            return;
        }
        setChargementSuggestions(true);
        const timer = setTimeout(() => {
            api.rechercherVillesOtaree(villeQuery.trim())
                .then((res) => setVilleSuggestions(res))
                .catch((e) => setErreurOtaree(e.message))
                .finally(() => setChargementSuggestions(false));
        }, VILLE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [villeQuery]);

    function onVilleInputChange(value) {
        setVilleQuery(value);
        setVilleSelectionnee(null);
        setSuggestionsOuvertes(true);
    }

    function onChoisirVille(suggestion) {
        setVilleQuery(suggestion.name);
        setVilleSelectionnee(suggestion);
        setVilleSuggestions([]);
        setSuggestionsOuvertes(false);
    }

    // La requête otaree-search reste en attente côté navigateur jusqu'à la fin complète du
    // traitement auto-publish (jusqu'à ~25-30 min pour 50 lots, séquentiel) — ce polling
    // séparé permet d'afficher une progression pendant ce temps au lieu de rester dans le flou.
    useEffect(() => {
        if (!rechercheOtareeEnCours) {
            setAutoPublishStatus(null);
            setAnnulationDemandee(false);
            return;
        }
        const poll = () => api.getAutoPublishStatus().then(setAutoPublishStatus).catch(() => {});
        poll();
        const id = setInterval(poll, 2000);
        return () => clearInterval(id);
    }, [rechercheOtareeEnCours]);

    // Partagé entre le comptage rapide et la vraie recherche — même filtres, une seule source.
    function construireFiltres() {
        const where = [{ label: villeSelectionnee.name, key: villeSelectionnee.code, value: villeSelectionnee.code }];
        const filters = { where };
        if (maxPrice.trim()) filters.maxPrice = maxPrice.trim();
        if (typologie.length) filters.typology = typologie;
        if (nature.length) filters.nature = nature;
        if (statut.length) filters.status = statut;
        if (minSurface.trim()) filters.minSurface = minSurface.trim();
        // Filtres avancés
        if (exposition.length) filters.exposure = exposition;
        if (etage.length) filters.floor = etage;
        if (loi.length) filters.law = loi;
        if (promoteur.length) filters.developer = promoteur;
        if (zoneFiscale.length) filters.taxArea = zoneFiscale;
        if (dependances.length) filters.annex = dependances;
        if (rentabiliteMin.trim()) filters.profitability = Number(rentabiliteMin.trim());
        if (commissionMin.trim()) filters.commissionRate = Number(commissionMin.trim());
        if (ajouteApres) filters.createdAfter = toOtareeDateString(ajouteApres);
        if (numeroBien.trim()) filters.propertyNumber = numeroBien.trim();
        if (surfaceDependancesMin.trim()) filters.minAnnexesSurface = surfaceDependancesMin.trim();
        return filters;
    }

    async function onAnnulerAutoPublish() {
        if (!autoPublishStatus) return;
        const restants = autoPublishStatus.total - autoPublishStatus.traites;
        const confirme = window.confirm(
            `Annuler cette recherche ? ${autoPublishStatus.traites} lot(s) déjà traité(s) resteront publiés, ` +
            `les ${restants} restant(s) ne seront pas traités.`
        );
        if (!confirme) return;
        setAnnulationDemandee(true);
        try {
            await api.annulerAutoPublish();
        } catch (e) {
            setErreurOtaree(e.message);
            setAnnulationDemandee(false);
        }
    }

    async function onCompterOtaree() {
        setErreurOtaree(null);
        setComptageOtaree(null);
        if (!villeSelectionnee) {
            setErreurOtaree('Choisis une ville dans les suggestions avant de compter les résultats.');
            return;
        }
        setComptageEnCours(true);
        try {
            const result = await api.compterOtaree(construireFiltres());
            setComptageOtaree(result);
        } catch (err) {
            setErreurOtaree(err.message);
        } finally {
            setComptageEnCours(false);
        }
    }

    function construireMessageResultat(result) {
        const dejaConnues = result.nbLots - result.nbNouvelles;
        return (
            `${result.nbLots} lot${result.nbLots > 1 ? 's' : ''} trouvé${result.nbLots > 1 ? 's' : ''} — ` +
            `${result.nbNouvelles} nouveau${result.nbNouvelles > 1 ? 'x' : ''}, ${dejaConnues} déjà connu${dejaConnues > 1 ? 's' : ''}` +
            (result.tronque
                ? ' — ⚠️ liste incomplète : limite de pagination atteinte, il existe probablement plus de résultats que ceux rapportés (recherche trop large, ex. une région entière).'
                : '') +
            (result.autoPublish?.annule
                ? ` — 🛑 auto-publication ANNULÉE manuellement (${result.autoPublish.nbTraites}/${result.autoPublish.nbCandidats} lot(s) traité(s) avant l'arrêt).`
                : '')
        );
    }

    async function onLancerRechercheOtaree(e) {
        e.preventDefault();
        setErreurOtaree(null);
        setResultatOtaree(null);
        setComptageOtaree(null);

        if (!villeSelectionnee) {
            setErreurOtaree('Choisis une ville dans les suggestions avant de lancer la recherche.');
            return;
        }

        const filters = construireFiltres();
        const resume = construireResumeFiltres({ villeSelectionnee, maxPrice, typologie, nature, statut, loi, promoteur });

        setRechercheOtareeEnCours(true);
        // Un seul run "en attente de confirmation" possible côté serveur à la fois — tant que
        // celui-ci n'est pas confirmé/annulé, le formulaire doit rester bloqué (sinon relancer
        // une 2e recherche écraserait silencieusement l'attente en cours). D'où le flag local :
        // le `finally` ne réactive le formulaire QUE si on ne vient pas de créer une attente.
        let laisseEnAttente = false;
        try {
            const result = await api.rechercherOtaree(filters, nomRecherche.trim(), resume, demanderConfirmation);
            if (result.autoPublish?.enAttente) {
                // Rien n'a été envoyé à Hubiflow — le récapitulatif attend une confirmation
                // explicite (voir onConfirmerEnvoi/onAnnulerEnvoiEnAttente).
                laisseEnAttente = true;
                const lots = result.autoPublish.candidatsApercu || [];
                const portailsDisponibles = result.autoPublish.portailsDisponibles || [];
                setConfirmationEnAttente({
                    nbCandidats: result.autoPublish.nbCandidats,
                    lots,
                    portailsDisponibles,
                    resultBase: result,
                });
                setLotsSelectionnes(new Set(lots.map((l) => l.id))); // tous cochés par défaut
                setReferencesEditees(new Map(lots.map((l) => [l.id, l.referenceGeneree || ''])));
                setDoublonsTrouves(new Map());
                setErreurDoublons(null);
                // Pré-coché = union des portails que les règles de routage ont résolus pour ces
                // candidats ; mode pré-rempli avec le mode par défaut du portail. Entièrement
                // modifiable ensuite (voir onTogglePortailChoix/onPortailModeChange).
                const portailsResolus = new Set(lots.flatMap((l) => (l.portails || []).map((p) => p.id)));
                setPortailsChoix(
                    new Map(
                        portailsDisponibles.map((p) => [
                            p.id,
                            { publier: portailsResolus.has(p.id), mode: p.mode_publication_defaut },
                        ])
                    )
                );
                return;
            }
            setResultatOtaree({
                message: construireMessageResultat(result),
                tronque: !!result.tronque,
                annule: !!result.autoPublish?.annule,
            });
        } catch (err) {
            setErreurOtaree(err.message);
        } finally {
            if (!laisseEnAttente) setRechercheOtareeEnCours(false);
        }
    }

    function onReferenceChange(id, value) {
        setReferencesEditees((prev) => new Map(prev).set(id, value));
    }

    function onToggleLotSelectionne(id) {
        setLotsSelectionnes((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function onTogglePortailChoix(portailId) {
        setPortailsChoix((prev) => {
            const next = new Map(prev);
            const actuel = next.get(portailId);
            next.set(portailId, { ...actuel, publier: !actuel.publier });
            return next;
        });
    }

    function onPortailModeChange(portailId, mode) {
        setPortailsChoix((prev) => {
            const next = new Map(prev);
            const actuel = next.get(portailId);
            next.set(portailId, { ...actuel, mode });
            return next;
        });
    }

    async function onOuvrirLotDetail(id) {
        setLotDetailId(id);
        setLotDetail(null);
        setLotDetailErreur(null);
        setLotDetailEnCours(true);
        try {
            const detail = await api.getLotDetail(id);
            setLotDetail(detail);
        } catch (err) {
            setLotDetailErreur(err.message);
        } finally {
            setLotDetailEnCours(false);
        }
    }

    function onFermerLotDetail() {
        setLotDetailId(null);
        setLotDetail(null);
        setLotDetailErreur(null);
    }

    async function onVerifierDoublons() {
        if (lotsSelectionnes.size === 0) return;
        setVerifDoublonsEnCours(true);
        setErreurDoublons(null);
        try {
            const portailsChoisis = [...portailsChoix.entries()]
                .filter(([, choix]) => choix.publier)
                .map(([portailId, choix]) => ({ portailId, mode: choix.mode }));
            const { resultats } = await api.verifierDoublons([...lotsSelectionnes], portailsChoisis);
            setDoublonsTrouves(new Map(Object.entries(resultats || {}).map(([id, v]) => [Number(id), v])));
        } catch (err) {
            setErreurDoublons(err.message);
        } finally {
            setVerifDoublonsEnCours(false);
        }
    }

    async function onConfirmerEnvoi() {
        const attente = confirmationEnAttente;
        if (!attente || lotsSelectionnes.size === 0) return;
        setConfirmationEnAttente(null);
        setConfirmationEnCours(true);
        setRechercheOtareeEnCours(true);
        try {
            const portailsChoisis = [...portailsChoix.entries()]
                .filter(([, choix]) => choix.publier)
                .map(([portailId, choix]) => ({ portailId, mode: choix.mode }));
            const referencesAEnvoyer = Object.fromEntries(
                [...lotsSelectionnes].map((id) => [id, referencesEditees.get(id) || ''])
            );
            const autoPublish = await api.confirmerAutoPublish([...lotsSelectionnes], portailsChoisis, referencesAEnvoyer);
            const result = { ...attente.resultBase, autoPublish };
            setResultatOtaree({
                message: construireMessageResultat(result),
                tronque: !!result.tronque,
                annule: !!autoPublish.annule,
            });
        } catch (err) {
            setErreurOtaree(err.message);
        } finally {
            setConfirmationEnCours(false);
            setRechercheOtareeEnCours(false);
        }
    }

    async function onAnnulerEnvoiEnAttente() {
        const attente = confirmationEnAttente;
        if (!attente) return;
        setConfirmationEnAttente(null);
        try {
            await api.annulerAutoPublishEnAttente();
            setResultatOtaree({
                message:
                    `${attente.resultBase.nbLots} lot(s) trouvé(s) — import effectué, mais traitement automatique annulé avant démarrage : ` +
                    `${attente.nbCandidats} lot(s) restent en attente, traitables manuellement depuis Supervision.`,
                tronque: !!attente.resultBase.tronque,
            });
        } catch (err) {
            setErreurOtaree(err.message);
        } finally {
            setRechercheOtareeEnCours(false);
        }
    }

    return (
        <section className="panel">
            {/* Bandeau de repli de la progression — visible quelle que soit la vue (accueil ou
                filtres), pour ne jamais perdre la visibilité d'un run réellement en cours. */}
            {autoPublishStatus?.enCours && !panneauProgressionOuvert && (
                <div className="progress-banner" style={{ margin: 'var(--space-6)' }} onClick={() => setPanneauProgressionOuvert(true)}>
                    <span>
                        Auto-publication en cours (mode {autoPublishStatus.mode}) : {autoPublishStatus.traites}/{autoPublishStatus.total} lot(s) traité(s)
                        {annulationDemandee ? ' — annulation demandée…' : ''}
                    </span>
                    <span className="progress-banner-link">Voir en plein écran</span>
                </div>
            )}

            <div className="recherche-accueil">
                <div className="recherche-accueil-mark">76</div>
                <h1 className="recherche-accueil-titre">IMMO76</h1>
                <p className="recherche-accueil-soustitre">Recherche Otaree en direct</p>
                <label className="recherche-accueil-barre">
                    <IconSearch width={20} height={20} />
                    <input
                        value={villeQuery}
                        onChange={(e) => onVilleInputChange(e.target.value)}
                        onFocus={() => setVue('filtres')}
                        placeholder="Où cherchez-vous ?"
                        autoComplete="off"
                    />
                </label>
            </div>

            {/* Le formulaire complet survole l'accueil en plein écran, fond flouté (voir
                Overlay.jsx) — fermer (croix, Échap, clic hors panneau, ou "Retour") ne fait que
                masquer l'affichage, jamais annuler une recherche en cours. */}
            <Overlay open={vue === 'filtres'} dismissible onDismiss={() => setVue('accueil')} size="fullscreen">
            <div className="panel-body">
                <div>
                    <button type="button" className="btn-retour" onClick={() => setVue('accueil')}>
                        ← Retour
                    </button>
                    <form onSubmit={onLancerRechercheOtaree}>
                        <div className="search-bar-container">
                            <label className="field autocomplete-wrap" style={{ flex: 1, minWidth: 200 }}>
                                <span className="field-label">Ville</span>
                                <input
                                    autoFocus
                                    value={villeQuery}
                                    onChange={(e) => onVilleInputChange(e.target.value)}
                                    onFocus={() => setSuggestionsOuvertes(true)}
                                    onBlur={() => setTimeout(() => setSuggestionsOuvertes(false), 150)}
                                    placeholder="Où cherchez-vous ?"
                                    autoComplete="off"
                                />
                                {suggestionsOuvertes && (chargementSuggestions || villeSuggestions.length > 0) && (
                                    <ul className="autocomplete-suggestions">
                                        {chargementSuggestions && <li className="autocomplete-loading">Recherche…</li>}
                                        {!chargementSuggestions &&
                                            villeSuggestions.map((s) => (
                                                <li key={s.code} onMouseDown={() => onChoisirVille(s)}>
                                                    <span>{s.name}</span>
                                                    <span className="autocomplete-type">{s.type === 'region' ? 'région' : 'ville'}</span>
                                                </li>
                                            ))}
                                    </ul>
                                )}
                            </label>
                            <label className="field" style={{ width: 120 }}>
                                <span className="field-label">Prix max (€)</span>
                                <input
                                    type="number"
                                    min="0"
                                    placeholder="Illimité"
                                    value={maxPrice}
                                    onChange={(e) => setMaxPrice(e.target.value)}
                                />
                            </label>
                            <label className="field" style={{ width: 130 }}>
                                <span className="field-label">Surface min (m²)</span>
                                <input
                                    type="number"
                                    min="0"
                                    placeholder="Ex: 40"
                                    value={minSurface}
                                    onChange={(e) => setMinSurface(e.target.value)}
                                />
                            </label>
                            <label className="field" style={{ width: 180 }}>
                                <span className="field-label">Nom de la campagne</span>
                                <input
                                    placeholder="Optionnel"
                                    value={nomRecherche}
                                    onChange={(e) => setNomRecherche(e.target.value)}
                                />
                            </label>
                            <label
                                className="switch"
                                style={{ margin: '4px 4px 4px 12px' }}
                                title="Quand activé : affiche un récapitulatif (lots, portails, mode de publication) avant de lancer la génération/publication automatique — rien ne part vers Hubiflow sans confirmation explicite. Désactivé : publication immédiate avec le routage automatique et le mode par défaut de chaque portail."
                            >
                                <input
                                    type="checkbox"
                                    checked={demanderConfirmation}
                                    onChange={(e) => setDemanderConfirmation(e.target.checked)}
                                />
                                <span className="switch-track" />
                                <span className="switch-label">Demander confirmation avant envoi</span>
                            </label>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={comptageEnCours || rechercheOtareeEnCours}
                                onClick={onCompterOtaree}
                                style={{ margin: '4px' }}
                                title="Aperçu rapide (1 page) — ne lance pas la recherche complète, aucune génération/publication déclenchée."
                            >
                                <IconRefresh style={comptageEnCours ? { animation: 'spin 0.8s linear infinite' } : undefined} />
                                {comptageEnCours ? 'Comptage…' : 'Combien de biens ?'}
                            </button>
                            <button type="submit" className="btn btn-primary" disabled={rechercheOtareeEnCours} style={{ borderRadius: 'var(--radius-md)', padding: '12px 24px', margin: '4px' }}>
                                <IconRefresh style={rechercheOtareeEnCours ? { animation: 'spin 0.8s linear infinite' } : undefined} />
                                {rechercheOtareeEnCours ? 'Recherche…' : 'Rechercher'}
                            </button>
                            {autoPublishStatus?.enCours && (
                                <button
                                    type="button"
                                    className="btn btn-ghost-danger"
                                    disabled={annulationDemandee}
                                    onClick={onAnnulerAutoPublish}
                                    style={{ margin: '4px' }}
                                >
                                    {annulationDemandee ? 'Annulation demandée…' : 'Annuler'}
                                </button>
                            )}
                        </div>
                        {comptageOtaree && (
                            <p className="hint" style={{ color: 'var(--accent)' }}>
                                {comptageOtaree.approximatif
                                    ? `${comptageOtaree.count}+ biens disponibles (au moins — comptage rapide sur la 1ère page seulement)`
                                    : `${comptageOtaree.count} bien${comptageOtaree.count > 1 ? 's' : ''} disponible${comptageOtaree.count > 1 ? 's' : ''}`}
                            </p>
                        )}

                        <div className="filter-groups-row">
                            <label className="field">
                                Typologie
                                <Select multiple value={typologie} onChange={setTypologie} options={TYPOLOGY_OPTIONS} placeholder="Toutes" />
                            </label>
                            <label className="field">
                                Nature
                                <Select multiple value={nature} onChange={setNature} options={NATURE_OPTIONS} placeholder="Toutes" />
                            </label>
                            <label className="field">
                                Statut
                                <Select multiple value={statut} onChange={setStatut} options={STATUS_OPTIONS} placeholder="Tous" />
                            </label>
                            <label className="field">
                                Dispositif / Loi
                                <Select multiple value={loi} onChange={setLoi} options={LAW_OPTIONS} placeholder="Tous" />
                            </label>
                            <label className="field">
                                Promoteur
                                <Select multiple value={promoteur} onChange={setPromoteur} options={DEVELOPER_OPTIONS} placeholder="Tous" />
                            </label>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                            <button
                                type="button"
                                className="btn-filter"
                                onClick={() => setFiltresAvancesOuverts((v) => !v)}
                            >
                                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                                Filtres avancés
                                <IconChevronDown width={14} height={14} style={filtresAvancesOuverts ? { transform: 'rotate(180deg)' } : undefined} />
                            </button>
                        </div>

                        {filtresAvancesOuverts && (
                            <div className="filter-groups-row" style={{ marginTop: 4 }}>
                                <label className="field">
                                    Exposition
                                    <Select multiple value={exposition} onChange={setExposition} options={EXPOSURE_OPTIONS} placeholder="Toutes" />
                                </label>
                                <label className="field">
                                    Étage
                                    <Select multiple value={etage} onChange={setEtage} options={FLOOR_OPTIONS} placeholder="Tous" />
                                </label>
                                <label className="field">
                                    Zone fiscale
                                    <Select multiple value={zoneFiscale} onChange={setZoneFiscale} options={TAX_AREA_OPTIONS} placeholder="Toutes" />
                                </label>
                                <label className="field">
                                    Dépendances
                                    <Select multiple value={dependances} onChange={setDependances} options={ANNEX_OPTIONS} placeholder="Aucune" />
                                </label>

                                <label className="field" style={{ width: 160 }}>
                                    Rentabilité min (%)
                                    <input type="number" min="0" step="0.1" value={rentabiliteMin} onChange={(e) => setRentabiliteMin(e.target.value)} />
                                </label>
                                <label className="field" style={{ width: 160 }}>
                                    Commission min (%)
                                    <input type="number" min="0" step="0.1" value={commissionMin} onChange={(e) => setCommissionMin(e.target.value)} />
                                </label>
                                <label className="field" style={{ width: 180 }}>
                                    Ajouté après le
                                    <input type="date" value={ajouteApres} onChange={(e) => setAjouteApres(e.target.value)} />
                                </label>
                                <label className="field" style={{ width: 160 }}>
                                    Numéro de bien
                                    <input placeholder="ex : 12" value={numeroBien} onChange={(e) => setNumeroBien(e.target.value)} />
                                </label>
                                <label className="field" style={{ width: 180 }}>
                                    Surface dépendances min
                                    <input type="number" min="0" value={surfaceDependancesMin} onChange={(e) => setSurfaceDependancesMin(e.target.value)} />
                                </label>
                            </div>
                        )}
                    </form>
                    <p className="hint">
                        Recherche Otaree directe, sans navigateur — utilise l'accès capturé par l'extension.
                        Autocomplétion en direct, comme sur Otaree. Les libellés "Statut X"/"Loi X"/étages 1000-2000
                        sont provisoires, en attente de confirmation du mapping exact.
                    </p>
                    {resultatOtaree && (
                        <p
                            className="hint"
                            style={{ color: resultatOtaree.annule ? 'var(--danger)' : resultatOtaree.tronque ? 'var(--warning)' : 'var(--success)' }}
                        >
                            {resultatOtaree.message}
                        </p>
                    )}
                    {erreurOtaree && <p className="text-error">{erreurOtaree}</p>}
                </div>
            </div>
            </Overlay>

            {/* dismissible=false : action à conséquence réelle, seul un choix explicite
                (Confirmer/Annuler) peut fermer ce panneau — comportement inchangé, juste
                agrandi en plein écran (voir Overlay.jsx). */}
            <Overlay open={!!confirmationEnAttente} dismissible={false} size="fullscreen">
                {confirmationEnAttente && (() => {
                    const nbPortailsChoisis = [...portailsChoix.values()].filter((c) => c.publier).length;
                    return (
                        <>
                            <h3>Confirmer l'envoi vers Hubiflow ?</h3>
                            <p className="hint">
                                {confirmationEnAttente.resultBase.nbLots} lot(s) trouvé(s), déjà importés — rien n'a encore été envoyé à Hubiflow.
                                Décoche les lots qui te semblent suspects (mauvais prix, mauvaise ville, doublon) avant de confirmer.
                            </p>
                            <p>
                                <strong>{lotsSelectionnes.size}</strong>/{confirmationEnAttente.nbCandidats} lot(s) sélectionné(s) seraient traités
                                (génération IA + publication)
                            </p>

                            <p className="panel-section-title">Portails de publication</p>
                            <p className="hint">
                                Pré-coché selon ce que les règles de routage auraient choisi automatiquement — modifie
                                librement avant de confirmer, y compris ajouter un portail ou changer son mode.
                            </p>
                            <div className="confirmation-portails-liste">
                                {(confirmationEnAttente.portailsDisponibles || []).map((p) => {
                                    const choix = portailsChoix.get(p.id) || { publier: false, mode: p.mode_publication_defaut };
                                    return (
                                        <label key={p.id} className="confirmation-portail-item">
                                            <input
                                                type="checkbox"
                                                checked={choix.publier}
                                                onChange={() => onTogglePortailChoix(p.id)}
                                            />
                                            <span className="confirmation-portail-nom">{p.nom}</span>
                                            <Select
                                                value={choix.mode}
                                                onChange={(mode) => onPortailModeChange(p.id, mode)}
                                                options={[
                                                    { value: 'brouillon', label: 'Brouillon' },
                                                    { value: 'actif', label: 'Annonce active' },
                                                ]}
                                                disabled={!choix.publier}
                                            />
                                        </label>
                                    );
                                })}
                                {(confirmationEnAttente.portailsDisponibles || []).length === 0 && (
                                    <p className="cell-muted">Aucun portail actif configuré — rien ne sera publié.</p>
                                )}
                            </div>

                            <div className="field-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                                <p className="hint" style={{ margin: 0 }}>
                                    Vérifie si des annonces similaires existent déjà sur Hubiflow (même ville, prix
                                    proche) avant de confirmer — pas automatique, ça part vers Hubiflow uniquement sur
                                    demande.
                                </p>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={onVerifierDoublons}
                                    disabled={verifDoublonsEnCours || lotsSelectionnes.size === 0}
                                >
                                    {verifDoublonsEnCours ? 'Vérification…' : 'Vérifier les doublons'}
                                </button>
                            </div>
                            {erreurDoublons && <p className="text-error">{erreurDoublons}</p>}

                            <div className="confirmation-lots-grid">
                                {confirmationEnAttente.lots.map((lot) => {
                                    const coche = lotsSelectionnes.has(lot.id);
                                    const doublons = doublonsTrouves.get(lot.id);
                                    return (
                                        <label
                                            key={lot.id}
                                            className={`confirmation-lot-card${coche ? '' : ' confirmation-lot-card-decoche'}`}
                                            onClick={() => onOuvrirLotDetail(lot.id)}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={coche}
                                                onChange={() => onToggleLotSelectionne(lot.id)}
                                                onClick={(e) => e.stopPropagation()}
                                                className="confirmation-lot-checkbox"
                                            />
                                            {lot.photo && !photosEnErreur.has(lot.id) ? (
                                                <img
                                                    src={lot.photo}
                                                    alt=""
                                                    className="confirmation-lot-photo"
                                                    onError={() => setPhotosEnErreur((prev) => new Set(prev).add(lot.id))}
                                                />
                                            ) : (
                                                <div className="confirmation-lot-photo confirmation-lot-photo-vide">
                                                    <IconRadar width={22} height={22} />
                                                </div>
                                            )}
                                            <div className="confirmation-lot-infos">
                                                <span className="confirmation-lot-titre">{lot.titre}</span>
                                                <span className="cell-muted">{lot.ville || '—'}</span>
                                                <span className="cell-muted">{lot.prix ? `${lot.prix.toLocaleString('fr-FR')} €` : '—'}</span>
                                                {doublons?.length > 0 && (
                                                    <span
                                                        className="badge badge-en_attente"
                                                        title={doublons
                                                            .map((d) => `${d.titre} — ${d.prix ? `${d.prix.toLocaleString('fr-FR')} €` : '?'} (${d.portailNom}, ${d.etat === 'B' ? 'brouillon' : 'actif'})`)
                                                            .join('\n')}
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        ⚠ {doublons.length} similaire{doublons.length > 1 ? 's' : ''} sur Hubiflow
                                                    </span>
                                                )}
                                                <input
                                                    className="cell-input cell-input-mono"
                                                    placeholder="Réf. LMNP (à saisir si vide)"
                                                    value={referencesEditees.get(lot.id) ?? ''}
                                                    onChange={(e) => onReferenceChange(lot.id, e.target.value)}
                                                    onClick={(e) => e.stopPropagation()}
                                                />
                                            </div>
                                        </label>
                                    );
                                })}
                            </div>
                            <div className="modal-actions">
                                <button type="button" className="btn btn-secondary" onClick={onAnnulerEnvoiEnAttente}>
                                    Annuler
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    disabled={lotsSelectionnes.size === 0 || nbPortailsChoisis === 0}
                                    onClick={onConfirmerEnvoi}
                                    title={
                                        lotsSelectionnes.size === 0
                                            ? 'Coche au moins un lot, ou clique Annuler.'
                                            : nbPortailsChoisis === 0
                                            ? 'Coche au moins un portail de publication, ou clique Annuler.'
                                            : undefined
                                    }
                                >
                                    Confirmer et lancer ({lotsSelectionnes.size})
                                </button>
                            </div>
                        </>
                    );
                })()}
            </Overlay>

            {/* Détail d'un lot cliqué sur l'écran de confirmation — panneau imbriqué, purement
                présentationnel : le fermer ne touche jamais lotsSelectionnes ni confirmationEnAttente,
                l'écran de confirmation en dessous reste intact. */}
            <Overlay open={!!lotDetailId} dismissible onDismiss={onFermerLotDetail} size="detail">
                {lotDetailEnCours && <p className="hint">Chargement du détail…</p>}
                {lotDetailErreur && <p className="text-error">{lotDetailErreur}</p>}
                {lotDetail && (
                    <>
                        <h3>{lotDetail.titre}</h3>
                        <p className="hint">
                            {lotDetail.ville || '—'} · {lotDetail.prix ? `${lotDetail.prix.toLocaleString('fr-FR')} €` : '—'}
                        </p>
                        {lotDetail.images.length > 0 ? (
                            <div className="lot-detail-gallery">
                                {lotDetail.images.map((src, i) => (
                                    <img key={i} src={src} alt="" className="lot-detail-photo" />
                                ))}
                            </div>
                        ) : (
                            <div className="confirmation-lot-photo confirmation-lot-photo-vide lot-detail-photo-vide">
                                <IconRadar width={28} height={28} />
                            </div>
                        )}
                        <ul className="lot-detail-caracteristiques">
                            <li>Surface : {lotDetail.surface ? `${lotDetail.surface} m²` : '—'}</li>
                            <li>Type : {lotDetail.typeBien || '—'}</li>
                            <li>Étage : {lotDetail.etage ?? '—'}</li>
                            <li>Pièces : {lotDetail.pieces ?? '—'}</li>
                        </ul>
                        {lotDetail.description && (
                            <p className="lot-detail-description">{lotDetail.description}</p>
                        )}
                        <p className="hint">
                            Titre, description et DPE définitifs seront générés par IA seulement après confirmation
                            de l'envoi — ce qui est affiché ici reflète les données brutes actuelles, pas encore le
                            contenu qui sera réellement publié sur Hubiflow.
                        </p>
                    </>
                )}
            </Overlay>

            {/* dismissible=true : "Continuer en arrière-plan" ne fait QUE fermer ce panneau
                (setPanneauProgressionOuvert(false)) — jamais annulerAutoPublish. Le run continue
                réellement, le bandeau de repli plus haut le rappelle et permet de rouvrir. */}
            <Overlay open={panneauProgressionOuvert && !!autoPublishStatus} dismissible onDismiss={() => setPanneauProgressionOuvert(false)} size="fullscreen">
                {autoPublishStatus && (
                    <>
                        <h3>Auto-publication {autoPublishStatus.enCours ? 'en cours' : 'terminée'} (mode {autoPublishStatus.mode})</h3>
                        <p className="hint" style={{ fontSize: 15 }}>
                            {autoPublishStatus.traites}/{autoPublishStatus.total} lot(s) traité(s)
                            {autoPublishStatus.lotEnCours ? ` — en cours : ${autoPublishStatus.lotEnCours}` : ''}
                            {autoPublishStatus.annule ? ' — 🛑 annulée manuellement.' : ''}
                            {annulationDemandee && autoPublishStatus.enCours ? ' — annulation demandée, arrêt après ce lot…' : ''}
                        </p>
                        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                            {autoPublishStatus.enCours ? (
                                <button
                                    type="button"
                                    className="btn btn-ghost-danger"
                                    disabled={annulationDemandee}
                                    onClick={onAnnulerAutoPublish}
                                >
                                    {annulationDemandee ? 'Annulation demandée…' : 'Annuler la recherche'}
                                </button>
                            ) : <span />}
                            <button type="button" className="btn btn-secondary" onClick={() => setPanneauProgressionOuvert(false)}>
                                {autoPublishStatus.enCours ? 'Continuer en arrière-plan' : 'Fermer'}
                            </button>
                        </div>
                    </>
                )}
            </Overlay>
        </section>
    );
}
