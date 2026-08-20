import { useEffect, useState } from 'react';

const CLOSE_ANIMATION_MS = 320;

// Panneau superposé réutilisable — purement présentationnel, ne possède aucun état métier.
// Fermer ce panneau (croix, Échap, clic hors panneau si `dismissible`) ne fait jamais que
// masquer l'affichage : ça n'annule rien, n'interrompt aucune requête en cours. L'appelant reste
// seul responsable de son propre state (recherche en cours, run auto-publish, formulaire...),
// qui continue à vivre exactement pareil que le panneau soit ouvert ou fermé.
//
// `size` : 'normal' (petite fenêtre centrée, comme l'écran de confirmation d'origine),
// 'fullscreen' (~92% de l'écran, pour les actions à conséquence réelle — voir CLAUDE.md du
// dashboard : recherche AUTO_PUBLISH=on, écran de confirmation détaillé, règle de routage,
// filtres de recherche), ou 'detail' (panneau imbriqué au-dessus d'un autre Overlay déjà ouvert,
// ex: détail d'un lot cliqué sur l'écran de confirmation — z-index supérieur, voir index.css).
// `dismissible` : si false, aucun moyen de fermer sans passer par une action explicite du
// contenu (ex: l'écran de confirmation reste obligatoire — Confirmer ou Annuler, rien d'autre).
//
// Animation d'entrée ET de sortie gérées ici, en interne : `open` passe à false -> le panneau
// reste monté un court instant de plus (`fermeture`) pour jouer l'animation de sortie, avant de
// vraiment démonter. Sans ce délai interne, React démonterait le panneau instantanément dès que
// l'appelant passe `open` à false, et seule l'animation d'entrée serait jamais visible.
export function Overlay({ open, onDismiss, dismissible = true, size = 'normal', children }) {
    const [monte, setMonte] = useState(open);
    const [fermeture, setFermeture] = useState(false);

    useEffect(() => {
        if (open) {
            setMonte(true);
            setFermeture(false);
            return;
        }
        if (!monte) return;
        setFermeture(true);
        const t = setTimeout(() => {
            setMonte(false);
            setFermeture(false);
        }, CLOSE_ANIMATION_MS);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open || !dismissible) return;
        function onKeyDown(e) {
            if (e.key === 'Escape') onDismiss?.();
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open, dismissible, onDismiss]);

    if (!monte) return null;

    return (
        <div
            className={`modal-overlay${size === 'fullscreen' ? ' modal-overlay-fullscreen' : ''}${size === 'detail' ? ' modal-overlay-detail' : ''}${fermeture ? ' modal-overlay-fermeture' : ''}`}
            onClick={dismissible ? onDismiss : undefined}
        >
            <div
                className={`modal-card${size === 'fullscreen' ? ' modal-card-fullscreen' : ''}${size === 'detail' ? ' modal-card-detail' : ''}${fermeture ? ' modal-card-fermeture' : ''}`}
                onClick={(e) => e.stopPropagation()}
            >
                {dismissible && (
                    <button type="button" className="modal-close" onClick={onDismiss} title="Fermer">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                )}
                {children}
            </div>
        </div>
    );
}
