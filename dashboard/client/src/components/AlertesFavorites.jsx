import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Overlay } from './Overlay.jsx';
import { IconBell } from './icons.jsx';

// Bouton discret dans l'en-tête (même pattern que l'icône ⚙️ Règles de routage) : badge si au
// moins une recherche favorite a de nouveaux lots depuis la dernière ouverture de ce panneau.
// Poll (pas juste au montage) pour que le badge reflète les rescrapes programmés qui arrivent
// pendant que l'onglet reste ouvert, sans action de l'utilisateur.
export function AlertesFavorites() {
    const [alertes, setAlertes] = useState(null);
    const [ouvert, setOuvert] = useState(false);
    const [erreur, setErreur] = useState(null);

    function refresh() {
        api.getAlertes().then(setAlertes).catch(() => setAlertes(null));
    }

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, 30000);
        return () => clearInterval(id);
    }, []);

    async function onOuvrir() {
        setOuvert(true);
        setErreur(null);
        try {
            const fraiches = await api.getAlertes();
            setAlertes(fraiches);
            await api.marquerAlertesConsultees();
            // Consultation faite : les compteurs affichés dans CE panneau restent visibles tels
            // quels (l'utilisateur vient de les voir), mais le badge du bouton doit retomber à 0
            // immédiatement plutôt qu'attendre le prochain poll.
            setAlertes((prev) => (prev ? prev.map((r) => ({ ...r, badgeConsomme: true })) : prev));
        } catch (err) {
            setErreur(err.message);
        }
    }

    const totalNouveaux = (alertes ?? []).reduce(
        (sum, r) => sum + (r.badgeConsomme ? 0 : r.nouveaux_lots),
        0
    );

    return (
        <>
            <button
                type="button"
                className="sidebar-nav-btn"
                onClick={onOuvrir}
                title="Alertes des recherches favorites"
            >
                <IconBell width={20} height={20} />
                <span className="sidebar-nav-label">Notifications</span>
                {totalNouveaux > 0 && (
                    <span className="icon-badge">{totalNouveaux > 99 ? '99+' : totalNouveaux}</span>
                )}
            </button>

            <Overlay open={ouvert} onDismiss={() => setOuvert(false)} size="normal">
                <h3>Recherches favorites</h3>
                {erreur && <p className="text-error">{erreur}</p>}
                {alertes && alertes.length === 0 && (
                    <p className="hint">
                        Aucune recherche favorite pour l'instant — marque une recherche d'un clic sur son
                        étoile dans l'historique pour être alerté de ses nouveaux lots ici.
                    </p>
                )}
                {alertes && alertes.length > 0 && (
                    <ul className="alertes-liste">
                        {alertes.map((r) => (
                            <li key={r.id} className="alertes-item">
                                <span className="alertes-item-nom">{r.nom || r.resume || r.url}</span>
                                {r.frequence_minutes ? (
                                    <span className={r.nouveaux_lots > 0 ? 'alertes-item-badge' : 'cell-muted'}>
                                        {r.nouveaux_lots > 0
                                            ? `${r.nouveaux_lots} nouveau${r.nouveaux_lots > 1 ? 'x' : ''} lot${r.nouveaux_lots > 1 ? 's' : ''}`
                                            : 'Rien de nouveau'}
                                    </span>
                                ) : (
                                    <span className="cell-muted">Pas de fréquence programmée — aucune vérification automatique</span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setOuvert(false)}>
                        Fermer
                    </button>
                </div>
            </Overlay>
        </>
    );
}
