import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { IconGauge, IconRefresh, IconAlert, IconTrash, IconCloudCheck } from './icons.jsx';
import { Select } from './Select.jsx';

const MODE_OPTIONS = [
    { value: 'brouillon', label: 'Souhaité : Brouillon' },
    { value: 'actif', label: 'Souhaité : Actif', title: 'Publication réellement publique sur Hubiflow — à utiliser avec prudence, lot par lot.' },
];

const STATUT_LABEL = {
    en_attente: 'En attente',
    envoyee: 'Envoyée à Ubiflow',
    publiee: 'Publiée',
    // Brouillon seul sur Hubiflow (pas actif) — soit parce qu'une activation a échoué, soit
    // parce qu'une synchronisation a confirmé cet état (voir etat_hubiflow_confirme) : les deux
    // cas mènent au même statut, le libellé reste volontairement neutre.
    publiee_brouillon: 'Brouillon sur Hubiflow',
    depubliee: 'Dépubliée (STATUS: S)',
    erreur: 'Erreur',
};

const ETAT_HUBIFLOW_LABEL = { B: 'Brouillon', A: 'Actif', S: 'Supprimée' };

function StatutBadge({ statut }) {
    return <span className={`badge badge-${statut}`}>{STATUT_LABEL[statut] ?? statut}</span>;
}

function ModeBadge({ mode }) {
    return <span className={`badge badge-mode-${mode}`}>{mode === 'actif' ? 'Actif' : 'Brouillon'}</span>;
}

// `actif` (l'onglet Superviser est bien celui affiché en ce moment) : voir le commentaire
// équivalent dans Historique.jsx — sans ce garde-fou, le rafraîchissement (2 requêtes à la
// fois : annonces + portails) tournait toutes les 5s en continu même sur un onglet jamais
// regardé, une part importante du trafic de fond qui a fini par déclencher la protection
// anti-robot de Cloudflare devant Render.
export function Supervision({ actif }) {
    const [annonces, setAnnonces] = useState([]);
    const [portails, setPortails] = useState([]);
    const [erreur, setErreur] = useState(null);
    const [busyKey, setBusyKey] = useState(null);
    const [recherche, setRecherche] = useState('');
    const [pageAnnonces, setPageAnnonces] = useState(1);

    // Panneau d'action "en attente" (voir carte statistique plus bas) — réutilise exactement les
    // mêmes endpoints que le bouton équivalent de l'écran Rechercher (ScraperControl.jsx), aucune
    // nouvelle logique métier. Compteur volontairement distinct de stats.enAttente (voir ce
    // dernier plus bas, basé sur annonce_portails.statut) : /lots-en-attente-count reflète le
    // vrai périmètre sur lequel ces deux actions agissent (annonces.donnees_ia IS NULL) — les deux
    // chiffres peuvent légitimement différer légèrement, jamais mélangés l'un avec l'autre.
    const [panneauEnAttenteOuvert, setPanneauEnAttenteOuvert] = useState(false);
    const [enAttenteCount, setEnAttenteCount] = useState(null);
    const [traitementEnCours, setTraitementEnCours] = useState(false);
    const [suppressionEnCours, setSuppressionEnCours] = useState(false);
    const [messageAction, setMessageAction] = useState(null);
    const panneauEnAttenteRef = useRef(null);

    const LIMIT_ANNONCES = 10;

    const refresh = useCallback((q) => {
        Promise.all([api.getAnnonces(q), api.getPortails()])
            .then(([a, p]) => {
                setAnnonces(a);
                setPortails(p);
            })
            .catch((e) => setErreur(e.message));
    }, []);

    // Fermeture au clic ailleurs sur la page — même mécanisme (ref + mousedown, vérifie que le
    // clic est réellement hors de l'élément) que Select.jsx, déjà éprouvé dans ce projet pour ce
    // même besoin. Préféré à un stopPropagation() sur le panneau lui-même, plus fragile.
    useEffect(() => {
        if (!panneauEnAttenteOuvert) return;
        function onClickOutside(e) {
            if (panneauEnAttenteRef.current && !panneauEnAttenteRef.current.contains(e.target)) {
                setPanneauEnAttenteOuvert(false);
            }
        }
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [panneauEnAttenteOuvert]);

    function rafraichirCompteurEnAttente() {
        api.getLotsEnAttenteCount().then(({ count }) => setEnAttenteCount(count)).catch(() => {});
    }

    // TEMPORAIRE — log de diagnostic (popover "En attente" signalé non fonctionnel) : à retirer
    // une fois confirmé que le clic ouvre bien le panneau en conditions réelles.
    function onTogglePanneauEnAttente() {
        console.log('[Supervision] clic carte "En attente", panneauEnAttenteOuvert avant =', panneauEnAttenteOuvert);
        const prochainEtat = !panneauEnAttenteOuvert;
        setPanneauEnAttenteOuvert(prochainEtat);
        if (prochainEtat) {
            setMessageAction(null);
            rafraichirCompteurEnAttente();
        }
    }

    // Même mécanisme que "Traiter les lots en attente" (ScraperControl.jsx) — en mode 'on' (le
    // mode par défaut), les candidats sont mis en attente de confirmation côté serveur, pas
    // directement publiés : cet écran n'a pas d'écran de confirmation propre (pas de duplication
    // voulue de cette UI), donc on redirige simplement vers l'onglet Rechercher pour valider.
    async function onTraiterEnAttente() {
        setTraitementEnCours(true);
        setMessageAction(null);
        try {
            const autoPublish = await api.traiterLotsEnAttente();
            if (autoPublish.enAttente) {
                setMessageAction(`${autoPublish.nbCandidats} lot(s) proposé(s) — rendez-vous sur l'onglet "Rechercher" pour les sélectionner et confirmer la publication.`);
            } else if (!autoPublish.nbCandidats) {
                setMessageAction('Aucun lot en attente à traiter.');
            } else {
                setMessageAction(`${autoPublish.nbTraites} lot(s) traité(s) directement (mode ${autoPublish.mode}).`);
            }
            rafraichirCompteurEnAttente();
            refresh(recherche);
        } catch (e) {
            setMessageAction(`Erreur : ${e.message}`);
        } finally {
            setTraitementEnCours(false);
        }
    }

    async function onSupprimerEnAttente() {
        if (!window.confirm(`Supprimer les ${enAttenteCount ?? ''} lot(s) en attente ? Action irréversible.`)) return;
        setSuppressionEnCours(true);
        setMessageAction(null);
        try {
            const { supprimees } = await api.supprimerLotsEnAttente();
            setMessageAction(`${supprimees} lot(s) supprimé(s).`);
            setEnAttenteCount(0);
            refresh(recherche);
        } catch (e) {
            setMessageAction(`Erreur : ${e.message}`);
        } finally {
            setSuppressionEnCours(false);
        }
    }

    // Dans la réalité, un seul espace Hubiflow a un token actif côté serveur à la fois —
    // publier vers un portail qui n'est pas l'espace actif échouerait (ou publierait au
    // mauvais endroit) une fois la vraie intégration branchée.
    const portailsNonActifs = new Set(portails.filter((p) => !p.est_espace_actif).map((p) => p.id));

    // Debounce léger : évite une requête par frappe pendant la saisie de la recherche. Gated par
    // actif (comme le polling juste en dessous) : ce panneau reste monté en permanence (voir
    // App.jsx), donc sans ce garde ce fetch initial partirait dès le chargement de la page même
    // si l'utilisateur reste sur un autre onglet — actif dans les dépendances redéclenche bien un
    // fetch frais à chaque fois qu'on revient sur Superviser, jamais d'affichage vide au premier clic.
    useEffect(() => {
        if (!actif) return;
        const id = setTimeout(() => refresh(recherche), 300);
        return () => clearTimeout(id);
    }, [actif, recherche, refresh]);

    useEffect(() => {
        if (!actif) return;
        const id = setInterval(() => refresh(recherche), 5000);
        return () => clearInterval(id);
    }, [actif, recherche, refresh]);

    async function onChangeMode(annonceId, portailId, mode) {
        const key = `mode-${annonceId}-${portailId}`;
        setBusyKey(key);
        try {
            await api.setInstanceMode(annonceId, portailId, mode);
        } catch (e) {
            setErreur(e.message);
        } finally {
            setBusyKey(null);
            refresh(recherche);
        }
    }

    async function onRepublish(annonceId, portailId, mode, titre) {
        // Republier avec le mode "actif" publie réellement et publiquement sur Hubiflow — la
        // sélection du mode dans le menu ne déclenche rien en elle-même, mais ce clic est le
        // vrai point de non-retour, donc c'est ici que la confirmation doit avoir lieu.
        if (mode === 'actif' && !window.confirm(`Publier "${titre}" en ACTIF sur Hubiflow ? Cette annonce deviendra réellement publique.`)) {
            return;
        }
        const key = `${annonceId}-${portailId}`;
        setBusyKey(key);
        try {
            await api.republish(annonceId, portailId);
        } catch (e) {
            setErreur(e.message);
        } finally {
            setBusyKey(null);
            refresh(recherche);
        }
    }

    // Retour arrière immédiat — confirmation obligatoire, action réelle et immédiate sur
    // Hubiflow (STATUS: "S"), pas une simple modification locale.
    async function onDepublier(annonceId, portailId, titre) {
        if (!window.confirm(`Dépublier/supprimer "${titre}" sur Hubiflow ? Cette action est immédiate et réelle.`)) {
            return;
        }
        const key = `depub-${annonceId}-${portailId}`;
        setBusyKey(key);
        try {
            await api.depublier(annonceId, portailId);
        } catch (e) {
            setErreur(e.message);
        } finally {
            setBusyKey(null);
            refresh(recherche);
        }
    }

    // Resynchronisation manuelle, lecture seule sur Hubiflow — pour refléter un changement fait
    // directement sur leur interface (ex: quelqu'un repasse l'annonce en brouillon là-bas).
    async function onSynchroniser(annonceId, portailId) {
        const key = `sync-${annonceId}-${portailId}`;
        setBusyKey(key);
        try {
            await api.synchroniser(annonceId, portailId);
        } catch (e) {
            setErreur(e.message);
        } finally {
            setBusyKey(null);
            refresh(recherche);
        }
    }

    async function onToggleTest(a) {
        try {
            await api.setAnnonceTest(a.id, !a.est_annonce_test);
            refresh(recherche);
        } catch (e) {
            setErreur(e.message);
        }
    }

    const toutesInstances = annonces.flatMap((a) => a.portails);
    const stats = {
        annonces: annonces.length,
        publiees: toutesInstances.filter((p) => p.statut === 'publiee').length,
        enAttente: toutesInstances.filter((p) => p.statut === 'en_attente').length,
        erreurs: toutesInstances.filter((p) => p.statut === 'erreur').length,
    };

    const totalPagesAnnonces = Math.max(1, Math.ceil(annonces.length / LIMIT_ANNONCES));
    const annoncesPaginated = annonces.slice((pageAnnonces - 1) * LIMIT_ANNONCES, pageAnnonces * LIMIT_ANNONCES);

    return (
        <section className="panel">
            <div className="panel-header">
                <div className="panel-icon">
                    <IconGauge />
                </div>
                <div className="panel-heading">
                    <h2>Supervision</h2>
                    <p>Statut de diffusion par annonce et par portail — republish et édition restent optionnels.</p>
                </div>
            </div>

            <div className="panel-body">
                <div className="stat-grid">
                    <div className="stat-card">
                        <span className="stat-label">Annonces</span>
                        <span className="stat-value">{stats.annonces}</span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-label">Publiées</span>
                        <span className="stat-value" style={{ color: 'var(--success)' }}>{stats.publiees}</span>
                    </div>
                    <div ref={panneauEnAttenteRef} className="stat-card" style={{ position: 'relative' }}>
                        <div style={{ cursor: 'pointer' }} onClick={onTogglePanneauEnAttente}>
                            <span className="stat-label">En attente</span>
                            <span className="stat-value" style={{ color: 'var(--warning)' }}>{stats.enAttente}</span>
                        </div>

                        {panneauEnAttenteOuvert && (
                            <div
                                className="panel"
                                style={{
                                    position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
                                    width: 280, padding: 16, textAlign: 'left', cursor: 'default',
                                    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                                }}
                            >
                                <p className="hint" style={{ marginTop: 0 }}>
                                    {enAttenteCount === null
                                        ? 'Chargement…'
                                        : `${enAttenteCount} lot(s) jamais générés (toutes recherches confondues).`}
                                </p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        disabled={traitementEnCours || suppressionEnCours || !enAttenteCount}
                                        onClick={onTraiterEnAttente}
                                    >
                                        {traitementEnCours ? 'Traitement…' : 'Traiter les lots en attente'}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-ghost-danger"
                                        disabled={traitementEnCours || suppressionEnCours || !enAttenteCount}
                                        onClick={onSupprimerEnAttente}
                                    >
                                        {suppressionEnCours ? 'Suppression…' : 'Supprimer les lots en attente'}
                                    </button>
                                </div>
                                {messageAction && <p className="hint" style={{ marginBottom: 0 }}>{messageAction}</p>}
                            </div>
                        )}
                    </div>
                    <div className="stat-card">
                        <span className="stat-label">Erreurs</span>
                        <span className="stat-value" style={{ color: stats.erreurs > 0 ? 'var(--danger)' : 'var(--color-text)' }}>{stats.erreurs}</span>
                    </div>
                </div>

                <div>
                    <p className="panel-section-title">Annonces</p>
                    <input
                        type="text"
                        placeholder="Rechercher par id, titre ou ville…"
                        value={recherche}
                        onChange={(e) => setRecherche(e.target.value)}
                        style={{ marginBottom: 10, width: '100%', maxWidth: 360 }}
                    />
                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Annonce</th>
                                    <th>Ville</th>
                                    <th>Prix</th>
                                    <th>Scrapée le</th>
                                    <th>Test</th>
                                    <th style={{ minWidth: 260 }}>Statuts par portail</th>
                                </tr>
                            </thead>
                            <tbody>
                                {annoncesPaginated.map((a) => (
                                    <tr key={a.id}>
                                        <td style={{ fontWeight: 500 }}>
                                            {a.titre}
                                            {a.alerte_document && (
                                                <span
                                                    className="badge badge-en_attente"
                                                    style={{ marginLeft: 8, cursor: 'help' }}
                                                    title={a.alerte_document}
                                                >
                                                    <IconAlert width={12} height={12} /> document à vérifier
                                                </span>
                                            )}
                                        </td>
                                        <td className="cell-muted">{a.ville}</td>
                                        <td className="cell-muted">{a.prix ? `${a.prix.toLocaleString('fr-FR')} €` : '—'}</td>
                                        <td className="cell-muted">{a.scrapee_le}</td>
                                        <td>
                                            <label
                                                className="switch"
                                                title="Whitelist explicite : seules les annonces marquées ainsi peuvent déclencher une vraie publication Hubiflow en mode réel."
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={!!a.est_annonce_test}
                                                    onChange={() => onToggleTest(a)}
                                                />
                                                <span className="switch-track" />
                                            </label>
                                        </td>
                                        <td>
                                            <ul className="portail-statuses">
                                                {a.portails.map((p) => {
                                                    const key = `${a.id}-${p.portail_id}`;
                                                    const espaceInactif = portailsNonActifs.has(p.portail_id);
                                                    return (
                                                        <li key={p.id}>
                                                            <span className="portail-nom">{p.portail_nom}</span>
                                                            {espaceInactif && (
                                                                <span
                                                                    className="espace-inactif-warning"
                                                                    title="Ce portail n'est pas l'espace Hubiflow actuellement actif côté serveur — la publication échouerait ou irait au mauvais espace."
                                                                >
                                                                    <IconAlert width={13} height={13} />
                                                                    espace non actif
                                                                </span>
                                                            )}
                                                            <StatutBadge statut={p.statut} />
                                                            <Select
                                                                value={p.mode}
                                                                onChange={(mode) => onChangeMode(a.id, p.portail_id, mode)}
                                                                options={MODE_OPTIONS}
                                                                disabled={busyKey === `mode-${a.id}-${p.portail_id}`}
                                                                style={{ minWidth: 150 }}
                                                                title="Intention pour le prochain republish — ne reflète pas nécessairement l'état actuel réel sur Hubiflow (voir 'Confirmé' à droite)."
                                                            />
                                                            <button
                                                                className="btn btn-ghost btn-icon-only"
                                                                disabled={busyKey === key}
                                                                onClick={() => onRepublish(a.id, p.portail_id, p.mode, a.titre)}
                                                                title="Republier"
                                                            >
                                                                <IconRefresh
                                                                    style={busyKey === key ? { animation: 'spin 0.8s linear infinite' } : undefined}
                                                                />
                                                            </button>
                                                            {p.ad_id_externe && p.statut !== 'depubliee' && (
                                                                <button
                                                                    className="btn btn-ghost-danger btn-icon-only"
                                                                    disabled={busyKey === `depub-${a.id}-${p.portail_id}`}
                                                                    onClick={() => onDepublier(a.id, p.portail_id, a.titre)}
                                                                    title="Dépublier/supprimer immédiatement sur Hubiflow (STATUS: S) — retour arrière en cas de problème sur une annonce active."
                                                                >
                                                                    <IconTrash
                                                                        style={busyKey === `depub-${a.id}-${p.portail_id}` ? { animation: 'spin 0.8s linear infinite' } : undefined}
                                                                    />
                                                                </button>
                                                            )}
                                                            {p.ad_id_externe && (
                                                                <button
                                                                    className="btn btn-ghost btn-icon-only"
                                                                    disabled={busyKey === `sync-${a.id}-${p.portail_id}`}
                                                                    onClick={() => onSynchroniser(a.id, p.portail_id)}
                                                                    title="Vérifier l'état réel sur Hubiflow (lecture seule) — pour refléter un changement fait directement là-bas."
                                                                >
                                                                    <IconCloudCheck
                                                                        style={busyKey === `sync-${a.id}-${p.portail_id}` ? { animation: 'spin 0.8s linear infinite' } : undefined}
                                                                    />
                                                                </button>
                                                            )}
                                                            {p.etat_hubiflow_confirme && (
                                                                <span
                                                                    className="cell-muted"
                                                                    style={{ fontSize: 11.5 }}
                                                                    title={`Dernière vérification directe sur Hubiflow : ${p.etat_hubiflow_confirme_le}`}
                                                                >
                                                                    Confirmé : {ETAT_HUBIFLOW_LABEL[p.etat_hubiflow_confirme] ?? p.etat_hubiflow_confirme}
                                                                </span>
                                                            )}
                                                            {p.derniere_erreur && (
                                                                <span className="portail-error-msg">{p.derniere_erreur}</span>
                                                            )}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </td>
                                    </tr>
                                ))}
                                {annonces.length === 0 && (
                                    <tr className="empty-row">
                                        <td colSpan={6}>Aucune annonce pour l'instant — lance un scraping.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    {totalPagesAnnonces > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
                            <button className="btn btn-secondary" disabled={pageAnnonces === 1} onClick={() => setPageAnnonces(p => p - 1)}>Précédent</button>
                            <span style={{ alignSelf: 'center', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)' }}>Page {pageAnnonces} / {totalPagesAnnonces}</span>
                            <button className="btn btn-secondary" disabled={pageAnnonces === totalPagesAnnonces} onClick={() => setPageAnnonces(p => p + 1)}>Suivant</button>
                        </div>
                    )}
                </div>

                {erreur && <p className="text-error">{erreur}</p>}
            </div>
        </section>
    );
}
