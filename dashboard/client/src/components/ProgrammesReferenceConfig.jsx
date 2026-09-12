import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const then = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'));
    return then.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Section "Références de programme (Neuf)" de la page Réglages — saisie une seule fois par
// programme (program.id Otaree, partagé par tous les lots d'une même résidence), réutilisée
// automatiquement par genererReferenceNeuf pour générer {référence}-{n°lot} sur tout futur lot
// de ce programme, sans jamais avoir à ressaisir. Le program_id se trouve dans le raw_data d'un
// lot (pas affiché ailleurs dans l'interface pour l'instant) — saisie manuelle ici volontairement
// simple, pas encore reliée à l'écran de confirmation (voir discussion, à ajouter plus tard si besoin).
export function ProgrammesReferenceConfig({ actif }) {
    const [programmes, setProgrammes] = useState(null);
    const [erreur, setErreur] = useState(null);
    const [programId, setProgramId] = useState('');
    const [programNom, setProgramNom] = useState('');
    const [reference, setReference] = useState('');
    const [creationEnCours, setCreationEnCours] = useState(false);
    const [editionId, setEditionId] = useState(null);
    const [editionValeur, setEditionValeur] = useState('');

    const refresh = useCallback(() => {
        api.getProgrammesReference()
            .then((p) => {
                setProgrammes(p);
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
        if (!programId.trim() || !reference.trim()) {
            setErreur('Identifiant de programme et référence requis.');
            return;
        }
        setCreationEnCours(true);
        setErreur(null);
        try {
            await api.creerProgrammeReference(programId.trim(), programNom.trim() || null, reference.trim());
            setProgramId('');
            setProgramNom('');
            setReference('');
            refresh();
        } catch (e) {
            setErreur(e.message);
        } finally {
            setCreationEnCours(false);
        }
    }

    function onCommencerEdition(p) {
        setEditionId(p.id);
        setEditionValeur(p.reference);
    }

    async function onValiderEdition(p) {
        if (!editionValeur.trim()) return;
        try {
            await api.modifierProgrammeReference(p.id, editionValeur.trim());
            setEditionId(null);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    async function onSupprimer(p) {
        if (!window.confirm(`Supprimer la référence du programme "${p.program_nom || p.program_id}" ? Les futurs lots de ce programme n'auront plus de référence générée automatiquement.`)) return;
        try {
            await api.supprimerProgrammeReference(p.id);
            refresh();
        } catch (e) {
            setErreur(e.message);
        }
    }

    return (
        <div>
            <p className="panel-section-title">Références de programme (Neuf)</p>
            <p className="hint">
                Associe une référence saisie une fois par programme (résidence) à tous ses lots — génère
                automatiquement "référence-n°lot" sur chaque lot de ce programme, dans n'importe quelle
                recherche future.
            </p>

            <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                    <thead>
                        <tr>
                            <th>Programme</th>
                            <th>Identifiant Otaree</th>
                            <th>Référence</th>
                            <th>Mise à jour</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {(programmes || []).map((p) => (
                            <tr key={p.id}>
                                <td>{p.program_nom || '—'}</td>
                                <td className="cell-muted">{p.program_id}</td>
                                <td>
                                    {editionId === p.id ? (
                                        <input
                                            autoFocus
                                            value={editionValeur}
                                            onChange={(e) => setEditionValeur(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && onValiderEdition(p)}
                                            style={{ width: 140 }}
                                        />
                                    ) : (
                                        <strong>{p.reference}</strong>
                                    )}
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
                        {programmes && programmes.length === 0 && (
                            <tr className="empty-row">
                                <td colSpan={5}>Aucun programme référencé pour l'instant.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <form className="field-row" style={{ marginTop: 16, flexWrap: 'wrap' }} onSubmit={onCreer}>
                <label className="field" style={{ width: 220 }}>
                    <span className="field-label">Identifiant Otaree du programme</span>
                    <input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="ex: e470fdf6dfc2" />
                </label>
                <label className="field" style={{ width: 200 }}>
                    <span className="field-label">Nom du programme (optionnel)</span>
                    <input value={programNom} onChange={(e) => setProgramNom(e.target.value)} placeholder="ex: Studéa Rouen Préfecture" />
                </label>
                <label className="field" style={{ width: 160 }}>
                    <span className="field-label">Référence</span>
                    <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ex: STU-ROUEN" />
                </label>
                <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={creationEnCours}>
                    {creationEnCours ? 'Enregistrement…' : 'Enregistrer'}
                </button>
            </form>

            {erreur && <p className="text-error">{erreur}</p>}
        </div>
    );
}
