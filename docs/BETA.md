# Legal Timers: betatest

Legal Timers is een schaakklok voor je uren. Je zet per dossier een timer
neer, en wie een timer start, pauzeert vanzelf de timer die liep. Aan het
eind van de dag heb je een afgerond overzicht dat je per veld kunt kopiëren
naar je urenregistratie.

Link: https://legaltimers.com

## Privacy

Alles blijft in je eigen browser (local storage). De pagina verstuurt niets:
geen account, geen analytics, geen server die je tijden ziet. Je kunt het
zelf controleren: open DevTools, tab Network, en herlaad de pagina.

Gevolg: wis je je browsergegevens, of gebruik je een andere browser of
computer, dan zie je je tijden niet. Maak af en toe een backup
(Instellingen, Exporteer backup).

## Zo werkt het

1. **Nieuwe timer**, typ het dossier, bijv. `Client BV / Matter / 2002100001`.
   Eerder gebruikte dossiers komen terug als suggestie. Daaronder kun je
   meteen de omschrijving typen; eerdere omschrijvingen bij hetzelfde
   dossier komen terug als suggestie.
2. **Start**. Start je een andere timer, dan pauzeert de eerste. Met
   **Alles pauzeren** (of spatie) zet je alles stil voor een pauze.
3. Tijd vergeten te starten? Klik in de tijd en typ wat het moet zijn:
   `1:30`, `1:30:00` of `1,5`.
4. **Gereed** zet een timer stil en markeert de tijd van vandaag als klaar.
   Met **Declarabel / Niet declarabel** op de kaart zet je of de tijd van die
   timer declarabel is (bijv. een intern dossier op niet declarabel). Dat
   geldt vanaf vandaag; eerdere dagen blijven zoals ze waren.
5. Tab **Dag**: per dossier de exacte en afgeronde tijd (standaard per 6
   minuten naar boven). Met de knopjes naast elk veld kopieer je
   dossiernummer, uren en omschrijving, in de volgorde van de
   urenregistratie. Vink **Overgenomen** aan (of klik op de regel) als je het
   hebt ingevoerd. Met **Vorige dag** kun je een eerdere dag alsnog invoeren.
   Met **Tijd toevoegen** schrijf je tijd met de hand, bijv. voor een
   telefoontje zonder timer of voor een eerdere dag. De exacte tijd in een
   regel kun je aanpassen. Met het kruisje (✕) achter een regel verwijder je
   de tijd van die dag.
   Per regel kun je declarabel alleen voor die dag omzetten. Onderaan staat
   het totaal, uitgesplitst in declarabel en niet declarabel.
6. Tab **Week**: uren per dossier per dag, met totalen declarabel en niet
   declarabel (niet declarabel is gekleurd). Een stip bij een dag betekent
   dat daar nog iets niet is overgenomen; klik op de dag om hem te openen.
   Zet in **Instellingen** een weeknorm voor declarabele uren, dan zie je
   hier hoe ver je bent.

Sneltoetsen op het Timers-tabblad: `1` t/m `9` start of wisselt naar die
timer, spatie pauzeert alles, `N` maakt een nieuwe timer.

Liep een timer langer dan 3 uur of over middernacht door, dan vraagt de
pagina of dat klopt. Met **Corrigeer eindtijd** vul je in hoe laat je echt
stopte.

## Wat we willen weten

- Klopt de afronding met hoe jij schrijft?
- Gaat het kopiëren naar je urenregistratie soepel, of mis je iets?
- Liep er ooit een timer door terwijl je dacht dat hij stond, of andersom?
- Ben je ooit tijd kwijtgeraakt? Zo ja: wat deed je net daarvoor?
- Wat mis je het meest?

## Bekende beperkingen

- Geen synchronisatie tussen computers of browsers, bewust.
- Een timer hernoemen verandert de naam ook op eerdere dagen.
- Getest in Chrome. Edge, Firefox en Safari zouden ook moeten werken; meld het
  als iets daar anders doet.

## Feedback

Stuur je bevindingen aan degene die je de link gaf, of maak een issue aan op
https://github.com/jorismaas1-web/legaltimers/issues (dat is openbaar). Een
screenshot en de stappen die je deed helpen het meest. Gebruik verzonnen
dossiers in screenshots: nooit echte cliëntnamen, dossiernummers of
omschrijvingen.

Legal Timers is open source (MIT-licentie). De code staat op
https://github.com/jorismaas1-web/legaltimers.
