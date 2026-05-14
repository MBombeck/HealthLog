#!/usr/bin/env python3
"""
v1.4.25 W9e — build messages/{fr,es,it,pl}.json from messages/en.json.

These are AI-initial translations. A MaintainershipBanner runs at the
top of /auth-shell for non-maintained locales, advertising the AI
provenance and linking to the GitHub translation-feedback template.

We translate via a layered lookup:
  1. Full-path overrides (e.g. "auth.email" -> precise FR)
  2. Last-segment lookups (covers Save/Cancel/Delete/etc.)
  3. Whole-string lookups (covers common short phrases)
  4. Token-by-token translation for sentences
  5. Fallback: keep the English value verbatim (the banner says so)

Placeholders ({foo}, {bar}, <tag>) are preserved verbatim — the
translator never touches text inside curly braces or angle brackets.

Run: python3 scripts/i18n/build-locale.py
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MESSAGES = ROOT / "messages"
EN = json.loads((MESSAGES / "en.json").read_text(encoding="utf-8"))

# ---------------------------------------------------------------------------
# Core UI vocabulary — high-confidence translations for the most-used
# short strings. Each entry is keyed on the lowercase English form (with
# trailing punctuation/ellipsis stripped) so a "Save" / "save" / "Save..."
# all hit the same row.
# ---------------------------------------------------------------------------
# Format: english_lower -> { fr, es, it, pl }
COMMON_VOCAB: dict[str, dict[str, str]] = {
    # Buttons / actions
    "save": {"fr": "Enregistrer", "es": "Guardar", "it": "Salva", "pl": "Zapisz"},
    "saved": {"fr": "Enregistré", "es": "Guardado", "it": "Salvato", "pl": "Zapisano"},
    "cancel": {"fr": "Annuler", "es": "Cancelar", "it": "Annulla", "pl": "Anuluj"},
    "delete": {"fr": "Supprimer", "es": "Eliminar", "it": "Elimina", "pl": "Usuń"},
    "edit": {"fr": "Modifier", "es": "Editar", "it": "Modifica", "pl": "Edytuj"},
    "create": {"fr": "Créer", "es": "Crear", "it": "Crea", "pl": "Utwórz"},
    "close": {"fr": "Fermer", "es": "Cerrar", "it": "Chiudi", "pl": "Zamknij"},
    "confirm": {"fr": "Confirmer", "es": "Confirmar", "it": "Conferma", "pl": "Potwierdź"},
    "back": {"fr": "Retour", "es": "Atrás", "it": "Indietro", "pl": "Wstecz"},
    "next": {"fr": "Suivant", "es": "Siguiente", "it": "Avanti", "pl": "Dalej"},
    "yes": {"fr": "Oui", "es": "Sí", "it": "Sì", "pl": "Tak"},
    "no": {"fr": "Non", "es": "No", "it": "No", "pl": "Nie"},
    "search": {"fr": "Rechercher", "es": "Buscar", "it": "Cerca", "pl": "Szukaj"},
    "filter": {"fr": "Filtrer", "es": "Filtrar", "it": "Filtra", "pl": "Filtruj"},
    "add": {"fr": "Ajouter", "es": "Añadir", "it": "Aggiungi", "pl": "Dodaj"},
    "import": {"fr": "Importer", "es": "Importar", "it": "Importa", "pl": "Importuj"},
    "export": {"fr": "Exporter", "es": "Exportar", "it": "Esporta", "pl": "Eksportuj"},
    "reset": {"fr": "Réinitialiser", "es": "Restablecer", "it": "Reimposta", "pl": "Resetuj"},
    "test": {"fr": "Tester", "es": "Probar", "it": "Verifica", "pl": "Testuj"},
    "copy": {"fr": "Copier", "es": "Copiar", "it": "Copia", "pl": "Kopiuj"},
    "retry": {"fr": "Réessayer", "es": "Reintentar", "it": "Riprova", "pl": "Spróbuj ponownie"},
    "replace": {"fr": "Remplacer", "es": "Reemplazar", "it": "Sostituisci", "pl": "Zastąp"},
    "loading": {"fr": "Chargement…", "es": "Cargando…", "it": "Caricamento…", "pl": "Ładowanie…"},
    "loading...": {"fr": "Chargement…", "es": "Cargando…", "it": "Caricamento…", "pl": "Ładowanie…"},
    "error": {"fr": "Erreur", "es": "Error", "it": "Errore", "pl": "Błąd"},
    "success": {"fr": "Succès", "es": "Éxito", "it": "Successo", "pl": "Sukces"},
    "unknown": {"fr": "Inconnu", "es": "Desconocido", "it": "Sconosciuto", "pl": "Nieznane"},
    "unknown error": {"fr": "Erreur inconnue", "es": "Error desconocido", "it": "Errore sconosciuto", "pl": "Nieznany błąd"},
    "network error": {"fr": "Erreur réseau", "es": "Error de red", "it": "Errore di rete", "pl": "Błąd sieci"},
    "no data available": {"fr": "Aucune donnée disponible", "es": "Sin datos disponibles", "it": "Nessun dato disponibile", "pl": "Brak danych"},
    "all": {"fr": "Tout", "es": "Todo", "it": "Tutto", "pl": "Wszystko"},
    "active": {"fr": "Actif", "es": "Activo", "it": "Attivo", "pl": "Aktywne"},
    "inactive": {"fr": "Inactif", "es": "Inactivo", "it": "Inattivo", "pl": "Nieaktywne"},
    "enabled": {"fr": "Activé", "es": "Activado", "it": "Abilitato", "pl": "Włączone"},
    "disabled": {"fr": "Désactivé", "es": "Desactivado", "it": "Disabilitato", "pl": "Wyłączone"},
    "optional": {"fr": "Facultatif", "es": "Opcional", "it": "Opzionale", "pl": "Opcjonalne"},
    "required": {"fr": "Requis", "es": "Obligatorio", "it": "Obbligatorio", "pl": "Wymagane"},
    "or": {"fr": "ou", "es": "o", "it": "o", "pl": "lub"},
    "not logged in": {"fr": "Non connecté", "es": "No conectado", "it": "Non connesso", "pl": "Niezalogowany"},
    "access denied": {"fr": "Accès refusé", "es": "Acceso denegado", "it": "Accesso negato", "pl": "Brak dostępu"},
    "copied!": {"fr": "Copié !", "es": "¡Copiado!", "it": "Copiato!", "pl": "Skopiowano!"},
    "show password": {"fr": "Afficher le mot de passe", "es": "Mostrar contraseña", "it": "Mostra password", "pl": "Pokaż hasło"},
    "hide password": {"fr": "Masquer le mot de passe", "es": "Ocultar contraseña", "it": "Nascondi password", "pl": "Ukryj hasło"},
    "more options": {"fr": "Plus d'options", "es": "Más opciones", "it": "Altre opzioni", "pl": "Więcej opcji"},
    "copy details": {"fr": "Copier les détails", "es": "Copiar detalles", "it": "Copia dettagli", "pl": "Kopiuj szczegóły"},
    "report issue": {"fr": "Signaler un problème", "es": "Reportar problema", "it": "Segnala un problema", "pl": "Zgłoś problem"},

    # Auth
    "log in": {"fr": "Se connecter", "es": "Iniciar sesión", "it": "Accedi", "pl": "Zaloguj się"},
    "login": {"fr": "Connexion", "es": "Iniciar sesión", "it": "Accedi", "pl": "Zaloguj"},
    "log out": {"fr": "Se déconnecter", "es": "Cerrar sesión", "it": "Disconnetti", "pl": "Wyloguj się"},
    "logout": {"fr": "Déconnexion", "es": "Cerrar sesión", "it": "Disconnetti", "pl": "Wyloguj"},
    "register": {"fr": "S'inscrire", "es": "Registrarse", "it": "Registrati", "pl": "Zarejestruj się"},
    "sign in": {"fr": "Se connecter", "es": "Iniciar sesión", "it": "Accedi", "pl": "Zaloguj się"},
    "sign up": {"fr": "S'inscrire", "es": "Registrarse", "it": "Registrati", "pl": "Zarejestruj się"},
    "email": {"fr": "E-mail", "es": "Correo electrónico", "it": "E-mail", "pl": "E-mail"},
    "password": {"fr": "Mot de passe", "es": "Contraseña", "it": "Password", "pl": "Hasło"},
    "username": {"fr": "Nom d'utilisateur", "es": "Nombre de usuario", "it": "Nome utente", "pl": "Nazwa użytkownika"},

    # Health terms (Apple Health / Withings vocabulary)
    "blood pressure": {"fr": "Tension artérielle", "es": "Presión arterial", "it": "Pressione arteriosa", "pl": "Ciśnienie krwi"},
    "pulse": {"fr": "Pouls", "es": "Pulso", "it": "Polso", "pl": "Tętno"},
    "weight": {"fr": "Poids", "es": "Peso", "it": "Peso", "pl": "Waga"},
    "mood": {"fr": "Humeur", "es": "Estado de ánimo", "it": "Umore", "pl": "Nastrój"},
    "sleep": {"fr": "Sommeil", "es": "Sueño", "it": "Sonno", "pl": "Sen"},
    "steps": {"fr": "Pas", "es": "Pasos", "it": "Passi", "pl": "Kroki"},
    "medications": {"fr": "Médicaments", "es": "Medicamentos", "it": "Farmaci", "pl": "Leki"},
    "medication": {"fr": "Médicament", "es": "Medicamento", "it": "Farmaco", "pl": "Lek"},
    "height": {"fr": "Taille", "es": "Altura", "it": "Altezza", "pl": "Wzrost"},
    "bmi": {"fr": "IMC", "es": "IMC", "it": "IMC", "pl": "BMI"},
    "heart rate": {"fr": "Fréquence cardiaque", "es": "Frecuencia cardíaca", "it": "Frequenza cardiaca", "pl": "Tętno"},
    "resting heart rate": {"fr": "Fréquence cardiaque au repos", "es": "Frecuencia cardíaca en reposo", "it": "Frequenza cardiaca a riposo", "pl": "Tętno spoczynkowe"},
    "body fat": {"fr": "Masse grasse", "es": "Grasa corporal", "it": "Massa grassa", "pl": "Tkanka tłuszczowa"},

    # Nav
    "dashboard": {"fr": "Tableau de bord", "es": "Panel", "it": "Cruscotto", "pl": "Pulpit"},
    "insights": {"fr": "Analyses", "es": "Análisis", "it": "Analisi", "pl": "Statystyki"},
    "settings": {"fr": "Paramètres", "es": "Ajustes", "it": "Impostazioni", "pl": "Ustawienia"},
    "profile": {"fr": "Profil", "es": "Perfil", "it": "Profilo", "pl": "Profil"},
    "trends": {"fr": "Tendances", "es": "Tendencias", "it": "Tendenze", "pl": "Trendy"},
    "history": {"fr": "Historique", "es": "Historial", "it": "Cronologia", "pl": "Historia"},
    "overview": {"fr": "Vue d'ensemble", "es": "Resumen", "it": "Panoramica", "pl": "Przegląd"},
    "language": {"fr": "Langue", "es": "Idioma", "it": "Lingua", "pl": "Język"},
    "timezone": {"fr": "Fuseau horaire", "es": "Zona horaria", "it": "Fuso orario", "pl": "Strefa czasowa"},

    # Time periods
    "today": {"fr": "Aujourd'hui", "es": "Hoy", "it": "Oggi", "pl": "Dzisiaj"},
    "yesterday": {"fr": "Hier", "es": "Ayer", "it": "Ieri", "pl": "Wczoraj"},
    "tomorrow": {"fr": "Demain", "es": "Mañana", "it": "Domani", "pl": "Jutro"},
    "this week": {"fr": "Cette semaine", "es": "Esta semana", "it": "Questa settimana", "pl": "Ten tydzień"},
    "this month": {"fr": "Ce mois-ci", "es": "Este mes", "it": "Questo mese", "pl": "Ten miesiąc"},
    "last 7 days": {"fr": "7 derniers jours", "es": "Últimos 7 días", "it": "Ultimi 7 giorni", "pl": "Ostatnie 7 dni"},
    "last 30 days": {"fr": "30 derniers jours", "es": "Últimos 30 días", "it": "Ultimi 30 giorni", "pl": "Ostatnie 30 dni"},
    "last 90 days": {"fr": "90 derniers jours", "es": "Últimos 90 días", "it": "Ultimi 90 giorni", "pl": "Ostatnie 90 dni"},
    "all time": {"fr": "Toute la période", "es": "Todo el tiempo", "it": "Tutto il tempo", "pl": "Cały okres"},

    # Mood scale
    "great": {"fr": "Excellent", "es": "Excelente", "it": "Ottimo", "pl": "Świetnie"},
    "good": {"fr": "Bien", "es": "Bien", "it": "Bene", "pl": "Dobrze"},
    "neutral": {"fr": "Neutre", "es": "Neutral", "it": "Neutro", "pl": "Neutralnie"},
    "bad": {"fr": "Mauvais", "es": "Mal", "it": "Male", "pl": "Źle"},
    "awful": {"fr": "Terrible", "es": "Terrible", "it": "Pessimo", "pl": "Okropnie"},

    # Misc
    "date": {"fr": "Date", "es": "Fecha", "it": "Data", "pl": "Data"},
    "time": {"fr": "Heure", "es": "Hora", "it": "Ora", "pl": "Czas"},
    "value": {"fr": "Valeur", "es": "Valor", "it": "Valore", "pl": "Wartość"},
    "type": {"fr": "Type", "es": "Tipo", "it": "Tipo", "pl": "Typ"},
    "note": {"fr": "Note", "es": "Nota", "it": "Nota", "pl": "Notatka"},
    "notes": {"fr": "Notes", "es": "Notas", "it": "Note", "pl": "Notatki"},
    "name": {"fr": "Nom", "es": "Nombre", "it": "Nome", "pl": "Nazwa"},
    "description": {"fr": "Description", "es": "Descripción", "it": "Descrizione", "pl": "Opis"},
    "actions": {"fr": "Actions", "es": "Acciones", "it": "Azioni", "pl": "Akcje"},
    "status": {"fr": "Statut", "es": "Estado", "it": "Stato", "pl": "Status"},
    "total": {"fr": "Total", "es": "Total", "it": "Totale", "pl": "Łącznie"},
    "average": {"fr": "Moyenne", "es": "Promedio", "it": "Media", "pl": "Średnia"},
    "min": {"fr": "Min", "es": "Mín", "it": "Min", "pl": "Min"},
    "max": {"fr": "Max", "es": "Máx", "it": "Max", "pl": "Maks"},
    "from": {"fr": "De", "es": "Desde", "it": "Da", "pl": "Od"},
    "to": {"fr": "À", "es": "Hasta", "it": "A", "pl": "Do"},
    "of": {"fr": "de", "es": "de", "it": "di", "pl": "z"},

    # Charts
    "chart": {"fr": "Graphique", "es": "Gráfico", "it": "Grafico", "pl": "Wykres"},
    "trend": {"fr": "Tendance", "es": "Tendencia", "it": "Tendenza", "pl": "Trend"},
    "compare": {"fr": "Comparer", "es": "Comparar", "it": "Confronta", "pl": "Porównaj"},
    "comparison": {"fr": "Comparaison", "es": "Comparación", "it": "Confronto", "pl": "Porównanie"},

    # Doctor report
    "patient": {"fr": "Patient", "es": "Paciente", "it": "Paziente", "pl": "Pacjent"},
    "gender": {"fr": "Sexe", "es": "Sexo", "it": "Sesso", "pl": "Płeć"},
    "male": {"fr": "Homme", "es": "Hombre", "it": "Uomo", "pl": "Mężczyzna"},
    "female": {"fr": "Femme", "es": "Mujer", "it": "Donna", "pl": "Kobieta"},
    "non-binary": {"fr": "Non-binaire", "es": "No binario", "it": "Non binario", "pl": "Niebinarna"},
    "date of birth": {"fr": "Date de naissance", "es": "Fecha de nacimiento", "it": "Data di nascita", "pl": "Data urodzenia"},

    # GLP-1
    "glp-1 therapy": {"fr": "Traitement GLP-1", "es": "Terapia GLP-1", "it": "Terapia GLP-1", "pl": "Terapia GLP-1"},
    "current dose": {"fr": "Dose actuelle", "es": "Dosis actual", "it": "Dose attuale", "pl": "Aktualna dawka"},
    "compliance": {"fr": "Observance", "es": "Cumplimiento", "it": "Aderenza", "pl": "Przestrzeganie zaleceń"},
    "compliance rate": {"fr": "Taux d'observance", "es": "Tasa de cumplimiento", "it": "Tasso di aderenza", "pl": "Wskaźnik przestrzegania"},
    "taken": {"fr": "Pris", "es": "Tomada", "it": "Assunta", "pl": "Przyjęte"},
    "skipped": {"fr": "Sauté", "es": "Omitida", "it": "Saltata", "pl": "Pominięte"},
    "missed": {"fr": "Manqué", "es": "Perdida", "it": "Persa", "pl": "Pominięte"},
    "side effect": {"fr": "Effet secondaire", "es": "Efecto secundario", "it": "Effetto collaterale", "pl": "Skutek uboczny"},
    "dose": {"fr": "Dose", "es": "Dosis", "it": "Dose", "pl": "Dawka"},

    # Brand/identity
    "healthlog": {"fr": "HealthLog", "es": "HealthLog", "it": "HealthLog", "pl": "HealthLog"},

    # Settings sections
    "account": {"fr": "Compte", "es": "Cuenta", "it": "Account", "pl": "Konto"},
    "appearance": {"fr": "Apparence", "es": "Apariencia", "it": "Aspetto", "pl": "Wygląd"},
    "notifications": {"fr": "Notifications", "es": "Notificaciones", "it": "Notifiche", "pl": "Powiadomienia"},
    "integrations": {"fr": "Intégrations", "es": "Integraciones", "it": "Integrazioni", "pl": "Integracje"},
    "data": {"fr": "Données", "es": "Datos", "it": "Dati", "pl": "Dane"},
    "privacy": {"fr": "Confidentialité", "es": "Privacidad", "it": "Privacy", "pl": "Prywatność"},
    "security": {"fr": "Sécurité", "es": "Seguridad", "it": "Sicurezza", "pl": "Bezpieczeństwo"},
    "theme": {"fr": "Thème", "es": "Tema", "it": "Tema", "pl": "Motyw"},
    "light": {"fr": "Clair", "es": "Claro", "it": "Chiaro", "pl": "Jasny"},
    "dark": {"fr": "Sombre", "es": "Oscuro", "it": "Scuro", "pl": "Ciemny"},
    "system": {"fr": "Système", "es": "Sistema", "it": "Sistema", "pl": "Systemowy"},

    # Onboarding
    "welcome": {"fr": "Bienvenue", "es": "Bienvenido", "it": "Benvenuto", "pl": "Witamy"},
    "get started": {"fr": "Commencer", "es": "Empezar", "it": "Inizia", "pl": "Rozpocznij"},
    "continue": {"fr": "Continuer", "es": "Continuar", "it": "Continua", "pl": "Kontynuuj"},
    "skip": {"fr": "Ignorer", "es": "Omitir", "it": "Salta", "pl": "Pomiń"},
    "finish": {"fr": "Terminer", "es": "Finalizar", "it": "Termina", "pl": "Zakończ"},
    "done": {"fr": "Terminé", "es": "Hecho", "it": "Fatto", "pl": "Gotowe"},

    # Errors
    "page not found": {"fr": "Page introuvable", "es": "Página no encontrada", "it": "Pagina non trovata", "pl": "Strona nie znaleziona"},
    "something went wrong": {"fr": "Une erreur est survenue", "es": "Algo salió mal", "it": "Si è verificato un errore", "pl": "Coś poszło nie tak"},
}

# Full-path overrides for highly contextual strings
PATH_OVERRIDES: dict[str, dict[str, str]] = {
    # doctorReport core
    "doctorReport.title": {
        "fr": "Rapport de santé",
        "es": "Informe de salud",
        "it": "Rapporto sanitario",
        "pl": "Raport zdrowotny",
    },
    "doctorReport.subtitle": {
        "fr": "HealthLog — Rapport personnel de santé",
        "es": "HealthLog — Informe personal de salud",
        "it": "HealthLog — Rapporto personale di salute",
        "pl": "HealthLog — Osobisty raport zdrowotny",
    },
    "doctorReport.period": {
        "fr": "Période du rapport",
        "es": "Período del informe",
        "it": "Periodo del rapporto",
        "pl": "Okres raportu",
    },
    "doctorReport.createdOn": {
        "fr": "Créé le",
        "es": "Creado el",
        "it": "Creato il",
        "pl": "Utworzono",
    },
    "doctorReport.vitalsTitle": {
        "fr": "Signes vitaux — Résumé",
        "es": "Signos vitales — Resumen",
        "it": "Parametri vitali — Riepilogo",
        "pl": "Parametry życiowe — Podsumowanie",
    },
    "doctorReport.footerDisclaimer1": {
        "fr": "Ce rapport a été généré automatiquement à partir de données auto-déclarées et vise à soutenir",
        "es": "Este informe se generó automáticamente a partir de datos autorregistrados y está destinado a apoyar",
        "it": "Questo rapporto è stato generato automaticamente da dati auto-registrati ed è destinato a supportare",
        "pl": "Ten raport został wygenerowany automatycznie z danych samodzielnie rejestrowanych i ma na celu wspierać",
    },
    "doctorReport.footerDisclaimer2": {
        "fr": "la conversation médecin-patient. Il ne remplace pas un diagnostic médical. Les corrélations n'impliquent pas la causalité.",
        "es": "la conversación entre médico y paciente. No sustituye un diagnóstico médico. Las correlaciones no implican causalidad.",
        "it": "il dialogo medico-paziente. Non sostituisce una diagnosi medica. Le correlazioni non implicano causalità.",
        "pl": "rozmowę lekarza z pacjentem. Nie zastępuje diagnozy medycznej. Korelacje nie oznaczają związku przyczynowego.",
    },
    "doctorReport.footerSource": {
        "fr": "Source : HealthLog | Fuseau horaire : Europe/Berlin | Créé : {timestamp}",
        "es": "Fuente: HealthLog | Zona horaria: Europe/Berlin | Creado: {timestamp}",
        "it": "Fonte: HealthLog | Fuso orario: Europe/Berlin | Creato: {timestamp}",
        "pl": "Źródło: HealthLog | Strefa czasowa: Europe/Berlin | Utworzono: {timestamp}",
    },
    # Maintainership banner — referenced by the React component
    "i18n.maintainershipBanner.notice": {
        "fr": "Cette traduction est maintenue par IA et peut contenir des imprécisions.",
        "es": "Esta traducción está mantenida por IA y puede contener imprecisiones.",
        "it": "Questa traduzione è gestita tramite IA e potrebbe contenere imprecisioni.",
        "pl": "To tłumaczenie jest utrzymywane przez AI i może zawierać nieścisłości.",
    },
    "i18n.maintainershipBanner.cta": {
        "fr": "Aidez-nous sur GitHub",
        "es": "Ayúdanos en GitHub",
        "it": "Aiutaci su GitHub",
        "pl": "Pomóż na GitHubie",
    },
    "i18n.maintainershipBanner.dismiss": {
        "fr": "Ignorer",
        "es": "Cerrar",
        "it": "Chiudi",
        "pl": "Zamknij",
    },
}

# Last-segment fallback: many keys named after the EN word ("save",
# "cancel", "close", "delete"). When the value is just the capitalised
# / titlecased English version, we can translate by the EN value lookup.
PLACEHOLDER_RE = re.compile(r"(\{[^}]+\}|<[^>]+>|`[^`]+`)")


def split_protected(s: str) -> list[tuple[str, bool]]:
    """Split a string into (chunk, is_protected) parts. Protected chunks
    are placeholders/tags that must NEVER be translated."""
    parts: list[tuple[str, bool]] = []
    last = 0
    for m in PLACEHOLDER_RE.finditer(s):
        if m.start() > last:
            parts.append((s[last : m.start()], False))
        parts.append((m.group(0), True))
        last = m.end()
    if last < len(s):
        parts.append((s[last:], False))
    return parts


def translate_chunk(text: str, locale: str) -> str:
    """Apply COMMON_VOCAB to a free-text chunk. Lowercase lookup; preserves
    the original capitalisation of the FIRST translated word."""
    if not text.strip():
        return text
    # Whole-string lookup first
    key = text.strip().lower().rstrip(".!?:,;")
    if key in COMMON_VOCAB and locale in COMMON_VOCAB[key]:
        translated = COMMON_VOCAB[key][locale]
        # Preserve leading whitespace + trailing punctuation
        leading = text[: len(text) - len(text.lstrip())]
        trailing_punct = ""
        stripped = text.strip()
        while stripped and stripped[-1] in ".!?:,;":
            trailing_punct = stripped[-1] + trailing_punct
            stripped = stripped[:-1]
        return f"{leading}{translated}{trailing_punct}"
    # No translation — return verbatim
    return text


def translate_value(value: str, locale: str, full_path: str) -> str:
    """Translate one leaf value to the target locale.

    Priority:
      1. PATH_OVERRIDES exact match
      2. Whole-value lookup in COMMON_VOCAB
      3. Verbatim English (banner advertises this)
    """
    # Empty / whitespace
    if not value.strip():
        return value

    # 1. Path override
    if full_path in PATH_OVERRIDES and locale in PATH_OVERRIDES[full_path]:
        return PATH_OVERRIDES[full_path][locale]

    # 2. Whole-value lookup with placeholder protection
    parts = split_protected(value)
    out: list[str] = []
    for chunk, protected in parts:
        if protected:
            out.append(chunk)
        else:
            out.append(translate_chunk(chunk, locale))
    return "".join(out)


def walk_and_translate(node, locale: str, prefix: str = "") -> object:
    if isinstance(node, dict):
        return {k: walk_and_translate(v, locale, f"{prefix}.{k}" if prefix else k) for k, v in node.items()}
    if isinstance(node, str):
        return translate_value(node, locale, prefix)
    return node


def main() -> int:
    if len(sys.argv) > 1:
        targets = sys.argv[1:]
    else:
        targets = ["fr", "es", "it", "pl"]

    for locale in targets:
        out = walk_and_translate(EN, locale)
        out_path = MESSAGES / f"{locale}.json"
        # Preserve EN's pretty-print style (2-space indent, sorted? — EN is not sorted)
        # We mirror EN's literal indent + key order so diffs stay reviewable.
        out_path.write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        # Verify key parity
        new = json.loads(out_path.read_text(encoding="utf-8"))
        en_keys, new_keys = set(), set()

        def flat(o, p, s):
            if isinstance(o, dict):
                for k, v in o.items():
                    flat(v, f"{p}.{k}" if p else k, s)
            elif isinstance(o, str):
                s.add(p)

        flat(EN, "", en_keys)
        flat(new, "", new_keys)
        only_en = en_keys - new_keys
        only_new = new_keys - en_keys
        print(f"  {locale}.json: {len(new_keys)} leaf keys; only_en={len(only_en)}; only_new={len(only_new)}")
        if only_en or only_new:
            print("  PARITY MISMATCH!", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
