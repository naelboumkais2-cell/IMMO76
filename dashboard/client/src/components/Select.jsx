import { useEffect, useRef, useState } from 'react';
import { IconChevronDown } from './icons.jsx';

// Menu déroulant custom-stylé — remplace les <select> natifs là où l'apparence du navigateur
// casserait l'harmonie visuelle (liste déroulante non stylable en CSS pur). Reste accessible au
// clavier (Entrée/Espace pour ouvrir, flèches pour naviguer, Échap pour fermer) et ferme au clic
// extérieur, comme un <select> natif se comporterait.
//
// Mode `multiple` : value/onChange manipulent un tableau au lieu d'une valeur scalaire, le menu
// reste ouvert après un clic (on coche plusieurs choses d'affilée), chaque option affiche une
// case à cocher, et le bouton résume la sélection ("T2, T3 (2 sélections)") plutôt que d'afficher
// un seul libellé — même esprit que le "9 sélections" de l'interface Otaree elle-même.
export function Select({ value, onChange, options, disabled, title, style, multiple = false, placeholder = '—' }) {
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(-1);
    const rootRef = useRef(null);

    useEffect(() => {
        if (!open) return;
        function onClickOutside(e) {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        }
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [open]);

    const valeurs = multiple ? value || [] : null;
    const selectedIndex = multiple ? -1 : options.findIndex((o) => o.value === value);
    const selected = multiple ? null : options[selectedIndex];
    const estCoche = (o) => multiple && valeurs.includes(o.value);

    function choisir(o) {
        if (o.disabled) return;
        if (multiple) {
            onChange(valeurs.includes(o.value) ? valeurs.filter((v) => v !== o.value) : [...valeurs, o.value]);
            // Reste ouvert : on coche plusieurs choix d'affilée, pas un choix unique qui referme.
        } else {
            onChange(o.value);
            setOpen(false);
        }
    }

    function onKeyDown(e) {
        if (disabled) return;
        if (e.key === 'Escape') {
            setOpen(false);
            return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (open && highlight >= 0) choisir(options[highlight]);
            else {
                setOpen(true);
                setHighlight(multiple ? 0 : selectedIndex >= 0 ? selectedIndex : 0);
            }
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) {
                setOpen(true);
                setHighlight(multiple ? 0 : selectedIndex >= 0 ? selectedIndex : 0);
                return;
            }
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            setHighlight((h) => (h + dir + options.length) % options.length);
        }
    }

    const label = multiple
        ? resumerSelection(options.filter((o) => valeurs.includes(o.value)), placeholder)
        : selected?.label ?? placeholder;

    return (
        <div className="custom-select" ref={rootRef} style={style} title={title}>
            <button
                type="button"
                className={`custom-select-trigger${multiple && valeurs.length ? ' has-value' : ''}`}
                disabled={disabled}
                onClick={() => {
                    setOpen((v) => !v);
                    setHighlight(multiple ? 0 : selectedIndex >= 0 ? selectedIndex : 0);
                }}
                onKeyDown={onKeyDown}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span>{label}</span>
                <IconChevronDown width={14} height={14} style={open ? { transform: 'rotate(180deg)' } : undefined} />
            </button>
            {open && (
                <ul className="custom-select-options" role="listbox">
                    {options.map((o, i) => (
                        <li
                            key={o.value}
                            role="option"
                            aria-selected={multiple ? estCoche(o) : o.value === value}
                            aria-disabled={o.disabled || undefined}
                            className={[
                                (multiple ? estCoche(o) : o.value === value) ? 'selected' : '',
                                o.disabled ? 'disabled' : '',
                                i === highlight ? 'highlighted' : '',
                            ].filter(Boolean).join(' ')}
                            title={o.title}
                            onMouseEnter={() => setHighlight(i)}
                            onClick={() => choisir(o)}
                        >
                            {multiple && <span className={`custom-select-checkbox${estCoche(o) ? ' checked' : ''}`} aria-hidden="true" />}
                            {o.label}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function resumerSelection(selectionnees, placeholder) {
    if (selectionnees.length === 0) return placeholder;
    const labels = selectionnees.map((o) => o.label);
    const apercu = labels.length <= 2 ? labels.join(', ') : `${labels.slice(0, 2).join(', ')}…`;
    return `${apercu} (${selectionnees.length} sélection${selectionnees.length > 1 ? 's' : ''})`;
}
