import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const then = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
    return then.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Section "Promoteurs Neuf reconnus" de la page Réglages — demande client 2026-09-22 : même
// principe que le LMNP (seuls les promoteurs reconnus permettent la diffusion automatique), mais
// éditable par l'agence elle-même, sans dépendre d'un déploiement de code à chaque nouveau
// promoteur (contrairement à promoteurs.js, mapping en dur côté LMNP). Saisie sur le NOM du
// promoteur (tel qu'affiché par Otaree, program.developer.name) — pas un identifiant technique,
// contrairement à ProgrammesReferenceConfig (program_id opaque) : l'agence connaît un nom de
// promoteur, jamais un id Otaree.
//
// Depuis le 2026-09-23, cette même liste alimente aussi directement le filtre "Promoteur" du
// formulaire de recherche (ScraperControl.jsx) — architecture à source unique, plus de duplication.
// L'id Otaree nécessaire à ce filtre (developer_id) est résolu AUTOMATIQUEMENT côté serveur dès la
// création (voir routes/portails.js, resoudreDeveloppeurParNom) : rien à saisir ici. Un promoteur
// dont le nom ne correspond exactement à aucun promoteur connu d'Otaree reste "reconnu" (la
// référence se génère dès qu'un lot apparaît), mais n'apparaît pas encore dans le filtre de
// recherche tant qu'aucun id n'est résolu — d'où le statut affiché et le bouton "Réessayer".
export function PromoteursNeufConfig({ actif }) {
    const [promoteurs, setPromoteurs] = useState(null);
    const [erreur, setErreur] = useState(null);
    const [promoteurNom, setPromoteurNom] = useState('');
    const [initiales, setInitiales] = useState('');
    const [creationEnCours, setCreationEnCours] = useState(false);
    const [editionId, setEditionId] = useState(null);
    const [editionValeur, setEditionValeur] = useState('');
    const [resolutionEnCoursId, setResolutionEnCoursId] = useState(null);

    const refresh = useCallback(() => {
        api.getPromoteursNeuf()
            .then((p) => {
                setPromoteurs(p);
                setErreur(null);
            })
            .catch((e) => setErreur(e.message));
    }, []);

    useEffect(() => {
        if (!actif) return;
        refresh();
    }, [actif, refresh]);

    async function onCreer(e) {
        e.preventDefault();
        if (!promoteurNom.trim()) {
            setErreur('Nom du promoteur requis (exactement comme affiché par Otaree).');
            return;
        }
        setCreationEnCours(true);
        setErreur(null);
        try {
            await api.creerPromoteurNeuf(promoteurNom.trim(), initiales.trim() || null);
            setPromoteurNom('');
            setInitiales('');
            refresh();
        } catch (e) {
            setErreur(e.message);
        } finally {
            setCreationEnCours(false);
        }
    }

    function onCommencerEdition(p) {
        setEditionId(p.id);
        setEditionValeur(p.initiales || '');
    }

    async function onValiderEdition(p) {
        if (!editionValeur.trim()) return;
        try {
            await api.modifierPromoteurNeuf(p.id, { initiales: editionValeur.trim() });
            setEditionId(null);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onToggleActif(p) {
        try {
            await api.modifierPromoteurNeuf(p.id, { actif: !p.actif });
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onReessayerResolution(p) {
        setResolutionEnCoursId(p.id);
        try {
            await api.reessayerResolutionPromoteurNeuf(p.id);
            refresh();
        } catch (e) {
            setErreur(e.message);
        } finally {
            setResolutionEnCoursId(null);
        }
    }

    async function onSupprimer(p) {
        if (!window.confirm(`Supprimer "${p.promoteur_nom}" des promoteurs reconnus ? Ses futurs lots seront exclus de l'auto-publication (sauf référence de programme déjà configurée), et il disparaîtra du filtre de recherche.`)) return;
        try {
            await api.supprimerPromoteurNeuf(p.id);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    return (
        <div>
            <p className="panel-section-title">Promoteurs Neuf reconnus</p>
            <p className="hint">
                Seuls les promoteurs listés ici permettent la diffusion automatique d'un lot Neuf (référence
                générée "Initiales-VILLE-n°lot" une fois les initiales renseignées) — cette même liste
                alimente aussi directement le filtre "Promoteur" du formulaire de recherche, dès qu'un id
                Otaree a pu être résolu automatiquement. Ajoute un promoteur ici dès qu'un nouveau
                partenariat démarre, sans attendre un développement.
            </p>

            <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                    <thead>
                        <tr>
                            <th>Promoteur</th>
                            <th>Initiales</th>
                            <th>Filtre de recherche</th>
                            <th>Actif</th>
                            <th>Mise à jour</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {(promoteurs || []).map((p) => (
                            <tr key={p.id}>
                                <td>{p.promoteur_nom}</td>
                                <td>
                                    {editionId === p.id ? (
                                        <input
                                            autoFocus
                                            value={editionValeur}
                                            onChange={(e) => setEditionValeur(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && onValiderEdition(p)}
                                            style={{ width: 100 }}
                                        />
                                    ) : p.initiales ? (
                                        <strong>{p.initiales}</strong>
                                    ) : (
                                        <span className="hint">en attente</span>
                                    )}
                                </td>
                                <td>
                                    {p.developer_id ? (
                                        <span className="cell-muted" title={p.developer_id}>✓ actif dans le filtre</span>
                                    ) : (
                                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span className="text-error" title="Aucun promoteur Otaree ne correspond exactement à ce nom">non résolu</span>
                                            <button
                                                type="button"
                                                className="btn btn-ghost"
                                                onClick={() => onReessayerResolution(p)}
                                                disabled={resolutionEnCoursId === p.id}
                                            >
                                                {resolutionEnCoursId === p.id ? 'Recherche…' : 'Réessayer'}
                                            </button>
                                        </span>
                                    )}
                                </td>
                                <td>
                                    <button type="button" className="btn btn-ghost" onClick={() => onToggleActif(p)}>
                                        {p.actif ? 'Actif' : 'Désactivé'}
                                    </button>
                                </td>
                                <td className="cell-muted">{formatDate(p.maj_le)}</td>
                                <td className="col-tight" style={{ display: 'flex', gap: 6 }}>
                                    {editionId === p.id ? (
                                        <>
                                            <button type="button" className="btn btn-secondary" onClick={() => onValiderEdition(p)}>Valider</button>
                                            <button type="button" className="btn btn-ghost" onClick={() => setEditionId(null)}>Annuler</button>
                                        </>
                                    ) : (
                                        <>
                                            <button type="button" className="btn btn-secondary" onClick={() => onCommencerEdition(p)}>Modifier</button>
                                            <button type="button" className="btn btn-ghost-danger" onClick={() => onSupprimer(p)}>Supprimer</button>
                                        </>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {promoteurs && promoteurs.length === 0 && (
                            <tr className="empty-row">
                                <td colSpan={6}>Aucun promoteur reconnu pour l'instant.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <form className="field-row" style={{ marginTop: 16, flexWrap: 'wrap' }} onSubmit={onCreer}>
                <label className="field" style={{ width: 220 }}>
                    <span className="field-label">Nom du promoteur (Otaree)</span>
                    <input value={promoteurNom} onChange={(e) => setPromoteurNom(e.target.value)} placeholder="ex: Vinci Immobilier" />
                </label>
                <label className="field" style={{ width: 120 }}>
                    <span className="field-label">Initiales (optionnel)</span>
                    <input value={initiales} onChange={(e) => setInitiales(e.target.value)} placeholder="ex: VI" />
                </label>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={creationEnCours}>
                    {creationEnCours ? 'Enregistrement…' : 'Enregistrer'}
                </button>
            </form>

            {erreur && <p className="text-error">{erreur}</p>}
        </div>
    );
}
