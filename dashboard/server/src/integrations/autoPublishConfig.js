// Interrupteur explicite pour l'auto-publication depuis otaree-search — jamais activé
// silencieusement, même principe que hubiflowRouter.js pour HUBIFLOW_MODE.
//
// 'off' : aucun traitement automatique, otaree-search se comporte comme avant (import +
//   routage seulement, pas de génération IA ni de publication).
// 'test' : ne traite que les annonces marquées est_annonce_test=1 (même whitelist que celle
//   déjà utilisée pour valider le mode réel de Hubiflow) — pour tester sur 1-2 lots précis.
// 'on' (défaut depuis la validation des paliers 1-4 sur données réelles) : traite toutes les
//   annonces réellement nouvelles d'une recherche, jusqu'au plafond MAX_PAR_RUN.
const VALEURS_VALIDES = ['off', 'test', 'on'];

export function getMode() {
    const val = process.env.AUTO_PUBLISH;
    return VALEURS_VALIDES.includes(val) ? val : 'on';
}

// Plafond de sécurité par recherche : au-delà, les lots restent importés/visibles en
// Supervision mais pas auto-traités (republish manuel possible un par un). Évite qu'une
// recherche large (région entière) déclenche des centaines d'appels OpenAI/Hubiflow d'un coup.
// 50 = valeur de départ pour un usage régulier (validée après le test réel Strasbourg,
// 5/5 lots traités sans erreur). Relevé à 400 une fois l'écran de confirmation détaillé
// (sélection par lot, détail par carte) et l'annulation en cours de route disponibles — filet
// de sécurité supplémentaire qui rend un run large plus sûr à lancer.
export const MAX_PAR_RUN = Number(process.env.AUTO_PUBLISH_MAX_PAR_RUN) || 400;

const mode = getMode();
if (mode === 'off') {
    console.log('[auto-publish] Mode OFF — otaree-search importe sans générer ni publier.');
} else {
    console.log(`[auto-publish] ⚠️  Mode ${mode.toUpperCase()} actif (défaut) — plafond ${MAX_PAR_RUN} lot(s) par recherche.`);
}
