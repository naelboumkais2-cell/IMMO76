import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { IconHistory, IconStar } from './icons.jsx';
import { Select } from './Select.jsx';

// Fréquence de rescraping programmé — le scheduler (index.js) la respecte pour n'importe quelle
// recherche, favorite ou non. Le contrôle n'est affiché ici que pour les recherches favorites
// (apparition progressive au clic sur l'étoile) car c'est le seul cas où une fréquence sert à
// quelque chose côté UI actuelle (alimenter le panneau de notifications, voir
// AlertesFavorites.jsx) — pas de raison d'encombrer les lignes non favorites.
const FREQUENCE_OPTIONS = [
    { value: '', label: 'Manuel (pas de fréquence)' },
    { value: '15', label: 'Toutes les 15 min' },
    { value: '60', label: 'Toutes les heures' },
    { value: '360', label: 'Toutes les 6h' },
    { value: '1440', label: 'Tous les jours' },
];

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const then = new Date(dateStr.replace(' ', 'T') + 'Z');
    return then.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Page dédiée (accessible depuis la sidebar) — extraite de ScraperControl.jsx pour être
// consultable indépendamment de la page Rechercher, avec son propre fetch/polling.
//
// `actif` (l'onglet est bien celui affiché en ce moment) : le composant reste monté en
// permanence (voir App.jsx, jamais démonté au changement d'onglet), donc sans ce garde-fou le
// polling tournerait indéfiniment en arrière-plan même sur un onglet jamais regardé — constaté
// en conditions réelles : plusieurs pages sondaient le serveur toutes les 5s en continu,
// suffisamment de trafic pour déclencher la protection anti-robot de Cloudflare devant Render
// au bout de quelques minutes d'utilisation normale.
export function Historique({ actif }) {
    const [recherches, setRecherches] = useState(null);
    const [erreur, setErreur] = useState(null);

    const refresh = useCallback(() => {
        api.getRecherches().then(setRecherches).catch((e) => setErreur(e.message));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    useEffect(() => {
        if (!actif) return;
        const id = setInterval(refresh, 5000);
        return () => clearInterval(id);
    }, [actif, refresh]);

    async function onFrequenceChange(recherche, val) {
        const minutes = val === '' ? null : Number(val);
        const updated = await api.setRechercheFrequence(recherche.id, minutes);
        setRecherches((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    }

    async function onToggleFavori(recherche) {
        const updated = await api.setRechercheFavori(recherche.id, !recherche.favori);
        setRecherches((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    }

    if (!recherches) {
        return (
            <section className="panel">
                <div className="panel-body">
                    <p className="hint">Chargement…</p>
                </div>
            </section>
        );
    }

    return (
        <section className="panel">
            <div className="panel-header">
                <div className="panel-icon">
                    <IconHistory />
                </div>
                <div className="panel-heading">
                    <h2>Historique des recherches</h2>
                    <p>Toutes les recherches lancées, marque une favorite pour être alerté de ses nouveaux lots.</p>
                </div>
            </div>

            <div className="panel-body">
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th></th>
                                <th>Nom</th>
                                <th>Date</th>
                                <th>Résultats</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recherches.map((r) => (
                                <tr key={r.id}>
                                    <td>
                                        <button
                                            type="button"
                                            className={`btn-icon-star${r.favori ? ' active' : ''}`}
                                            onClick={() => onToggleFavori(r)}
                                            title={r.favori ? 'Retirer des favorites' : 'Marquer comme favorite (alertes de nouveaux lots)'}
                                        >
                                            <IconStar width={16} height={16} fill={r.favori ? 'currentColor' : 'none'} />
                                        </button>
                                    </td>
                                    <td style={{ fontWeight: 500 }} title={r.url}>
                                        {r.nom || r.resume || r.url}
                                        {r.favori && (
                                            <div className="recherche-frequence" onClick={(e) => e.stopPropagation()}>
                                                <Select
                                                    value={r.frequence_minutes ? String(r.frequence_minutes) : ''}
                                                    onChange={(val) => onFrequenceChange(r, val)}
                                                    options={FREQUENCE_OPTIONS}
                                                />
                                            </div>
                                        )}
                                    </td>
                                    <td className="cell-muted">{formatDate(r.derniere_execution_le)}</td>
                                    <td className="cell-muted">
                                        {r.derniere_erreur
                                            ? <span className="text-error">{r.derniere_erreur}</span>
                                            : `${r.dernieres_annonces_trouvees ?? 0} lot${(r.dernieres_annonces_trouvees ?? 0) > 1 ? 's' : ''}`}
                                    </td>
                                </tr>
                            ))}
                            {recherches.length === 0 && (
                                <tr className="empty-row">
                                    <td colSpan={4}>Aucune recherche pour l'instant.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {erreur && <p className="text-error">{erreur}</p>}
            </div>
        </section>
    );
}
