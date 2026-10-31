"""Beginner glossary: keywords, keyword actions and Commander terms with a one-line German explanation
(and an English one in ``TEXT_EN`` for a card's English side).

``TERMS`` maps the English term (as printed on English cards and in Scryfall's ``keywords``) to its
German card-text name (only where it is the established translation) and an explanation.
``find_terms`` finds glossary terms in a rules text (English or German).
"""

from __future__ import annotations

import re
from typing import Any

# English term -> (German name or "", explanation, kind)
_K, _A, _C = "keyword", "action", "concept"
TERMS: dict[str, tuple[str, str, str]] = {
    # --- evergreen keywords ---
    "Deathtouch": ("Todesberührung", "Jeder Schaden, den diese Karte einer Kreatur zufügt, reicht, um sie zu zerstören.", _K),
    "Defender": ("Verteidiger", "Kann nicht angreifen, aber blocken.", _K),
    "Double strike": ("Doppelschlag", "Fügt Kampfschaden zweimal zu: zuerst wie mit Erstschlag, dann noch einmal normal.", _K),
    "Enchant": ("Verzaubern", "Eine Aura wird beim Ins-Spiel-Kommen an das genannte Objekt (z. B. eine Kreatur) angelegt.", _K),
    "Equip": ("Ausrüsten", "Zahle die Kosten, um die Ausrüstung an eine deiner Kreaturen anzulegen – nur zu dem Zeitpunkt, an dem du eine Hexerei wirken könntest.", _K),
    "First strike": ("Erstschlag", "Fügt Kampfschaden vor den Kreaturen ohne Erstschlag zu – oft stirbt der Gegner, bevor er zurückschlägt.", _K),
    "Flash": ("Aufblitzen", "Darf jederzeit gespielt werden, wenn du auch einen Spontanzauber wirken könntest – auch im Zug eines Gegners.", _K),
    "Flying": ("Flugfähigkeit", "Kann nur von Kreaturen mit Flugfähigkeit oder Reichweite geblockt werden.", _K),
    "Haste": ("Eile", "Kann sofort angreifen und Fähigkeiten mit {T} nutzen, ohne einen Zug zu warten.", _K),
    "Hexproof": ("Fluchsicher", "Kann nicht das Ziel von Zaubersprüchen oder Fähigkeiten deiner Gegner werden (deine eigenen dürfen es).", _K),
    "Indestructible": ("Unzerstörbar", "Wird weder durch Schaden noch durch „zerstöre“ zerstört. Exil, Opfern oder -X/-X helfen trotzdem.", _K),
    "Lifelink": ("Lebensverknüpfung", "Jeder Schaden, den diese Karte zufügt, bringt dir genauso viele Lebenspunkte.", _K),
    "Menace": ("Bedrohlich", "Kann nur von zwei oder mehr Kreaturen gemeinsam geblockt werden.", _K),
    "Protection": ("Schutz", "Kann von Dingen mit der genannten Eigenschaft nicht geblockt, verzaubert, ausgerüstet oder als Ziel gewählt werden; ihr Schaden wird verhindert.", _K),
    "Reach": ("Reichweite", "Kann Kreaturen mit Flugfähigkeit blocken.", _K),
    "Shroud": ("", "Kann von niemandem als Ziel gewählt werden – auch nicht von dir selbst.", _K),
    "Trample": ("Trampelschaden", "Schaden über das hinaus, was die Blocker tödlich trifft, geht an den angegriffenen Spieler.", _K),
    "Vigilance": ("Wachsamkeit", "Wird beim Angreifen nicht getappt und kann danach noch blocken.", _K),
    "Ward": ("Abwehr", "Zielt ein Gegner darauf, muss er die Abwehrkosten zahlen – sonst wird sein Zauber bzw. seine Fähigkeit neutralisiert.", _K),
    # --- common keyword actions ---
    "Scry": ("Hellsicht", "Schau dir die obersten Karten deiner Bibliothek an; lege beliebig viele davon unter die Bibliothek, den Rest in beliebiger Reihenfolge zurück.", _A),
    "Surveil": ("Überwachen", "Wie Hellsicht, nur kommen die aussortierten Karten in deinen Friedhof statt unter die Bibliothek.", _A),
    "Mill": ("Mahlen", "Lege die obersten Karten deiner Bibliothek in deinen Friedhof.", _A),
    "Fight": ("Kämpfen", "Zwei Kreaturen fügen sich gegenseitig Schaden in Höhe ihrer Stärke zu – außerhalb des Kampfes.", _A),
    "Investigate": ("Nachforschen", "Erzeuge einen Hinweis-Spielstein (Artefakt: {2}, opfern: Ziehe eine Karte).", _A),
    "Explore": ("Erkunden", "Decke die oberste Karte auf. Ein Land kommt auf die Hand; sonst bekommt die Kreatur eine +1/+1-Marke und du darfst die Karte in den Friedhof legen.", _A),
    "Proliferate": ("Wuchern", "Wähle beliebig viele Spieler und bleibende Karten mit Marken; jede bekommt eine weitere Marke einer Art, die sie schon hat.", _A),
    "Connive": ("", "Ziehe eine Karte und wirf dann eine ab. Ist es eine Nicht-Land-Karte, bekommt die Kreatur eine +1/+1-Marke.", _A),
    "Amass": ("", "Lege +1/+1-Marken auf deine Armee – hast du keine, erzeuge zuerst einen 0/0-Armee-Spielstein.", _A),
    "Adapt": ("", "Hat die Kreatur keine +1/+1-Marken, bekommt sie die angegebene Anzahl.", _A),
    "Venture into the dungeon": ("", "Betritt ein Verlies oder gehe einen Raum weiter; jeder Raum hat einen Effekt.", _A),
    "Goad": ("", "Die Kreatur muss in jedem Kampf angreifen – und zwar möglichst einen anderen Spieler als dich.", _A),
    "Populate": ("", "Erzeuge eine Kopie eines Kreaturen-Spielsteins, den du kontrollierst.", _A),
    "Manifest": ("", "Lege die oberste Karte deiner Bibliothek verdeckt als 2/2-Kreatur ins Spiel; Kreaturen darunter kannst du für ihre Kosten umdrehen.", _A),
    # --- tokens and markers ---
    "Treasure": ("Schatz", "Artefakt-Spielstein: {T}, opfern: Erzeuge ein Mana einer beliebigen Farbe.", _A),
    "Food": ("Nahrung", "Artefakt-Spielstein: {2}, {T}, opfern: Du erhältst 3 Lebenspunkte.", _A),
    "Clue": ("Hinweis", "Artefakt-Spielstein: {2}, opfern: Ziehe eine Karte.", _A),
    "Monarch": ("", "Der Monarch zieht am Ende seines Zuges eine Karte. Fügt ihm eine Kreatur Kampfschaden zu, wird ihr Beherrscher zum Monarchen.", _C),
    "Initiative": ("", "Wer die Initiative hat, erkundet die Unterstadt (ein Verlies). Fügt ihm eine Kreatur Kampfschaden zu, nimmt ihr Beherrscher die Initiative.", _C),
    # --- other keywords you meet often in Commander ---
    "Affinity": ("Affinität", "Kostet für jedes Objekt der genannten Art, das du kontrollierst, {1} weniger.", _K),
    "Annihilator": ("", "Greift diese Kreatur an, opfert der verteidigende Spieler so viele bleibende Karten.", _K),
    "Buyback": ("", "Zahle die Zusatzkosten, dann kommt der Zauber nach dem Verrechnen auf deine Hand zurück statt in den Friedhof.", _K),
    "Cascade": ("Kaskade", "Beim Wirken deckst du Karten auf, bis eine Nicht-Land-Karte mit geringerem Manawert kommt – die darfst du kostenlos wirken.", _K),
    "Changeling": ("", "Hat jeden Kreaturentyp (zählt z. B. als Elf, Zombie und Drache zugleich).", _K),
    "Convoke": ("Einberufen", "Jede Kreatur, die du beim Wirken tappst, bezahlt {1} oder ein Mana ihrer Farbe.", _K),
    "Crew": ("", "Tappe Kreaturen mit zusammen mindestens der angegebenen Stärke: Das Fahrzeug wird bis zum Ende des Zuges eine Kreatur.", _K),
    "Cycling": ("", "Zahle die Kosten und wirf die Karte ab, um eine neue Karte zu ziehen.", _K),
    "Delve": ("", "Beim Wirken darfst du Karten aus deinem Friedhof ins Exil schicken; jede bezahlt {1}.", _K),
    "Dredge": ("", "Statt eine Karte zu ziehen, darfst du so viele Karten mahlen und diese Karte aus dem Friedhof auf die Hand nehmen.", _K),
    "Echo": ("", "Im nächsten Zug musst du die Kosten noch einmal zahlen, sonst opferst du die Karte.", _K),
    "Embalm": ("", "Schicke die Karte aus dem Friedhof ins Exil, um eine Spielstein-Kopie von ihr zu erzeugen (weiße Mumie).", _K),
    "Encore": ("", "Aus dem Friedhof ins Exil: Erzeuge für jeden Gegner eine Kopie mit Eile, die ihn angreifen muss; am Ende des Zuges geopfert.", _K),
    "Escape": ("", "Du kannst die Karte aus dem Friedhof wirken, indem du die Flucht-Kosten zahlst und andere Karten aus dem Friedhof ins Exil schickst.", _K),
    "Eternalize": ("", "Schicke die Karte aus dem Friedhof ins Exil, um eine 4/4-Spielstein-Kopie von ihr zu erzeugen.", _K),
    "Evoke": ("", "Kann für die alternativen Kosten gewirkt werden – dann wird sie beim Ins-Spiel-Kommen geopfert, ihr Effekt passiert trotzdem.", _K),
    "Exalted": ("", "Greift eine deiner Kreaturen allein an, bekommt sie für jede Karte mit Exalted +1/+1 bis zum Ende des Zuges.", _K),
    "Extort": ("", "Immer wenn du einen Zauberspruch wirkst, darfst du {W/B} zahlen: Jeder Gegner verliert 1 Leben, du erhältst so viel.", _K),
    "Flashback": ("Rückblende", "Du kannst die Karte ein zweites Mal aus deinem Friedhof wirken; danach kommt sie ins Exil.", _K),
    "Foretell": ("", "Schicke die Karte in deinem Zug für {2} verdeckt ins Exil und wirke sie später günstiger.", _K),
    "Hideaway": ("", "Beim Ins-Spiel-Kommen legst du eine der obersten Karten verdeckt ins Exil; unter einer Bedingung darfst du sie gratis spielen.", _K),
    "Improvise": ("", "Jedes Artefakt, das du beim Wirken tappst, bezahlt {1}.", _K),
    "Infect": ("", "Fügt Kreaturen Schaden als -1/-1-Marken und Spielern als Giftmarken zu (10 Giftmarken = verloren).", _K),
    "Kicker": ("Bonus", "Optionale Zusatzkosten beim Wirken – bezahlst du sie, wird der Effekt stärker.", _K),
    "Madness": ("", "Wirfst du die Karte ab, darfst du sie sofort für die Wahnsinn-Kosten wirken.", _K),
    "Miracle": ("", "Ist es die erste Karte, die du in diesem Zug ziehst, darfst du sie sofort für die Wunder-Kosten wirken.", _K),
    "Mutate": ("", "Für die Mutieren-Kosten auf eine deiner Nicht-Mensch-Kreaturen wirken: Beide verschmelzen und haben alle Fähigkeiten zusammen.", _K),
    "Myriad": ("", "Greift sie an, erzeugst du für jeden anderen Gegner eine angreifende Kopie; am Ende des Kampfes kommen die Kopien ins Exil.", _K),
    "Ninjutsu": ("", "Zahle die Kosten und nimm eine ungeblockte Angreiferin auf die Hand: Diese Karte kommt getappt und angreifend ins Spiel.", _K),
    "Partner": ("", "Zwei Commander mit Partner dürfen zusammen deine Commander sein; die Farbidentität ist die beider Karten.", _K),
    "Persist": ("", "Stirbt sie ohne -1/-1-Marke, kommt sie mit einer -1/-1-Marke zurück ins Spiel.", _K),
    "Poisonous": ("", "Fügt sie einem Spieler Kampfschaden zu, bekommt er die angegebene Anzahl Giftmarken.", _K),
    "Prowess": ("", "Immer wenn du einen Nicht-Kreaturen-Zauber wirkst, bekommt sie +1/+1 bis zum Ende des Zuges.", _K),
    "Rebound": ("", "Aus der Hand gewirkt, kommt der Zauber ins Exil und du darfst ihn zu Beginn deines nächsten Zuges kostenlos noch einmal wirken.", _K),
    "Riot": ("", "Wähle beim Ins-Spiel-Kommen: eine +1/+1-Marke oder Eile.", _K),
    "Scavenge": ("", "Schicke die Kreatur aus dem Friedhof ins Exil, um +1/+1-Marken in Höhe ihrer Stärke auf eine Kreatur zu legen.", _K),
    "Split second": ("", "Solange dieser Zauber auf dem Stapel liegt, kann niemand Zauber wirken oder aktivierte Fähigkeiten nutzen.", _K),
    "Storm": ("Sturm", "Beim Wirken kopierst du den Zauber für jeden Zauberspruch, der vorher in diesem Zug gewirkt wurde.", _K),
    "Suspend": ("", "Schicke die Karte mit Zeitmarken ins Exil; jede Runde geht eine weg, bei der letzten wirkst du sie kostenlos.", _K),
    "Toxic": ("", "Fügt sie einem Spieler Kampfschaden zu, bekommt er zusätzlich so viele Giftmarken.", _K),
    "Undying": ("", "Stirbt sie ohne +1/+1-Marke, kommt sie mit einer +1/+1-Marke zurück ins Spiel.", _K),
    "Unearth": ("", "Hol die Kreatur mit Eile aus dem Friedhof zurück (nur als Hexerei); am Ende des Zuges kommt sie ins Exil.", _K),
    "Wither": ("", "Fügt Kreaturen Schaden in Form von -1/-1-Marken zu.", _K),
    "Landfall": ("Landung", "Löst aus, wann immer ein Land unter deiner Kontrolle ins Spiel kommt.", _K),
    "Eminence": ("", "Wirkt schon, während dein Commander in der Kommandozone ist – nicht erst, wenn er im Spiel ist.", _K),
    "Lieutenant": ("", "Zusätzlicher Effekt, solange du deinen Commander kontrollierst.", _K),
    "Melee": ("", "Greift sie an, bekommt sie +1/+1 für jeden Gegner, den du in diesem Zug angegriffen hast.", _K),
    "Blitz": ("", "Für die Blitz-Kosten wirken: Eile, beim Sterben ziehst du eine Karte, am Ende des Zuges wird sie geopfert.", _K),
    "Casualty": ("", "Beim Wirken darfst du eine Kreatur mit mindestens der genannten Stärke opfern, um den Zauber zu kopieren.", _K),
    # --- Commander terms ---
    "Commander": ("", "Die legendäre Kreatur (oder erlaubte Karte), um die dein Deck gebaut ist. Sie startet in der Kommandozone.", _C),
    "Command zone": ("Kommandozone", "Hier liegt dein Commander zu Beginn. Von dort wirkst du ihn; stirbt er oder kommt ins Exil, darfst du ihn zurücklegen.", _C),
    "Commander tax": ("Commander-Steuer", "Jedes weitere Mal, das du den Commander aus der Kommandozone wirkst, kostet er {2} mehr.", _C),
    "Commander damage": ("Commander-Schaden", "Wer 21 oder mehr Kampfschaden von ein und demselben Commander bekommen hat, verliert das Spiel.", _C),
    "Color identity": ("Farbidentität", "Alle Farben in Kosten und Regeltext des Commanders. Jede Karte im Deck muss in diese Farben passen.", _C),
    "Singleton": ("", "Jede Karte darf nur einmal im Deck sein – außer Standardländer und Karten, die es ausdrücklich erlauben.", _C),
    "Bracket": ("", "Offizielle Stufen 1–5 für die Stärke eines Decks, damit am Tisch ähnlich starke Decks zusammenspielen.", _C),
    "Game Changer": ("", "Offizielle Liste besonders starker Karten. Bracket 1–2 erlauben keine, Bracket 3 bis zu drei.", _C),
    "Rule 0": ("", "Das Gespräch vor dem Spiel: Wie stark sind die Decks, was ist erwünscht, was nicht?", _C),
    "Ramp": ("", "Karten, die dir schneller mehr Mana geben (zusätzliche Länder, Manasteine) – damit du teure Karten früher spielst.", _C),
    "Card draw": ("Kartenzug", "Karten, die dich zusätzliche Karten ziehen lassen, damit dir die Optionen nicht ausgehen.", _C),
    "Removal": ("", "Karten, die eine einzelne gegnerische Bedrohung loswerden (zerstören, ins Exil schicken, zurückschicken).", _C),
    "Board wipe": ("", "Räumt viele oder alle Kreaturen (oder andere bleibende Karten) auf einmal ab – die Notbremse gegen große Armeen.", _C),
    "Tutor": ("", "Karte, die eine bestimmte andere Karte aus deiner Bibliothek sucht – macht Decks sehr zuverlässig.", _C),
    "Win condition": ("Siegbedingung", "Womit dein Deck das Spiel tatsächlich gewinnt – z. B. große Angreifer, Lebensentzug oder eine Combo.", _C),
    "Combo": ("", "Zwei oder mehr Karten, die zusammen einen sehr starken oder unendlichen Effekt ergeben.", _C),
    "Mulligan": ("", "Starthand neu ziehen. Im Commander ist der erste Mulligan frei, danach legst du pro Mulligan eine Karte unter.", _C),
    "Proxy": ("", "Selbst gedruckter Ersatz für eine Karte. In lockeren Runden meist okay – vorher absprechen.", _C),
    "Stax": ("", "Karten, die alle Spieler einschränken (z. B. teurere Zauber, weniger Enttappen). Mögen nicht alle Runden.", _C),
    "Voltron": ("", "Spielweise: Den Commander mit Auren und Ausrüstungen groß machen und über Commander-Schaden gewinnen.", _C),
    "Aristocrats": ("", "Spielweise: Eigene Kreaturen opfern und bei jedem Tod Vorteile ziehen (Leben entziehen, Karten ziehen).", _C),
    "Go wide": ("", "Spielweise: Viele kleine Kreaturen oder Spielsteine und diese gemeinsam stärken.", _C),
    "Reanimator": ("", "Spielweise: Große Kreaturen in den Friedhof bringen und von dort billig zurückholen.", _C),
    "Spellslinger": ("", "Spielweise: Viele Spontanzauber und Hexereien, die bei jedem Wirken Vorteile bringen.", _C),
    "Blink": ("", "Spielweise: Kreaturen kurz ins Exil schicken und zurückholen, um ihre Ins-Spiel-Effekte erneut auszulösen.", _C),
    "Group Hug": ("", "Spielweise: Allen Spielern helfen (Karten, Mana) und über Politik oder eine späte Wendung gewinnen.", _C),
}


# English explanations, shown when the card view shows a card's English side (issue #68).
TEXT_EN: dict[str, str] = {
    "Deathtouch": "Any amount of damage this deals to a creature is enough to destroy it.",
    "Defender": "Can't attack, but can block.",
    "Double strike": "Deals combat damage twice: first like first strike, then again as normal.",
    "Enchant": "An Aura is attached to the named object (a creature, for example) as it enters.",
    "Equip": "Pay the cost to attach the Equipment to one of your creatures – only when you could cast a sorcery.",
    "First strike": "Deals combat damage before creatures without first strike – often the opponent dies before it strikes back.",
    "Flash": "Can be cast any time you could cast an instant – even on an opponent's turn.",
    "Flying": "Can only be blocked by creatures with flying or reach.",
    "Haste": "Can attack and use {T} abilities right away, without waiting a turn.",
    "Hexproof": "Can't be the target of your opponents' spells or abilities (yours may target it).",
    "Indestructible": "Isn't destroyed by damage or by “destroy”. Exile, sacrifice or -X/-X still work.",
    "Lifelink": "Damage dealt by this card also gives you that much life.",
    "Menace": "Can only be blocked by two or more creatures together.",
    "Protection": "Can't be blocked, enchanted, equipped or targeted by things with the named quality; their damage is prevented.",
    "Reach": "Can block creatures with flying.",
    "Shroud": "Can't be the target of anything – not even your own spells.",
    "Trample": "Damage beyond what is lethal to the blockers goes to the player it attacks.",
    "Vigilance": "Doesn't tap to attack, so it can still block afterwards.",
    "Ward": "When an opponent targets it, they must pay the ward cost – or their spell or ability is countered.",
    "Scry": "Look at the top cards of your library; put any number of them on the bottom, the rest back in any order.",
    "Surveil": "Like scry, but the cards you sort out go to your graveyard instead of the bottom of your library.",
    "Mill": "Put the top cards of your library into your graveyard.",
    "Fight": "Two creatures deal damage equal to their power to each other – outside of combat.",
    "Investigate": "Create a Clue token (artifact: {2}, sacrifice: draw a card).",
    "Explore": "Reveal the top card. A land goes to your hand; otherwise the creature gets a +1/+1 counter and you may put the card into your graveyard.",
    "Proliferate": "Choose any number of players and permanents with counters; each gets another counter of a kind it already has.",
    "Connive": "Draw a card, then discard a card. If it's a nonland card, the creature gets a +1/+1 counter.",
    "Amass": "Put +1/+1 counters on your Army – if you have none, first create a 0/0 Army token.",
    "Adapt": "If the creature has no +1/+1 counters, it gets the given number of them.",
    "Venture into the dungeon": "Enter a dungeon or move on to the next room; each room has an effect.",
    "Goad": "The creature must attack each combat – and attack a player other than you if it can.",
    "Populate": "Create a copy of a creature token you control.",
    "Manifest": "Put the top card of your library onto the battlefield face down as a 2/2 creature; a creature card can be turned up for its cost.",
    "Treasure": "Artifact token: {T}, sacrifice: add one mana of any color.",
    "Food": "Artifact token: {2}, {T}, sacrifice: you gain 3 life.",
    "Clue": "Artifact token: {2}, sacrifice: draw a card.",
    "Monarch": "The monarch draws a card at the end of their turn. When a creature deals combat damage to them, its controller becomes the monarch.",
    "Initiative": "Whoever has the initiative ventures into the Undercity (a dungeon). When a creature deals combat damage to them, its controller takes the initiative.",
    "Affinity": "Costs {1} less for each object of the named kind you control.",
    "Annihilator": "When this creature attacks, the defending player sacrifices that many permanents.",
    "Buyback": "Pay the extra cost and the spell returns to your hand as it resolves instead of going to the graveyard.",
    "Cascade": "When you cast it, reveal cards until a nonland card with lower mana value shows up – you may cast that one for free.",
    "Changeling": "Has every creature type (counts as an Elf, a Zombie and a Dragon at once, for example).",
    "Convoke": "Each creature you tap while casting it pays for {1} or one mana of its color.",
    "Crew": "Tap creatures with total power of at least the number: the Vehicle becomes a creature until end of turn.",
    "Cycling": "Pay the cost and discard the card to draw a new one.",
    "Delve": "While casting it you may exile cards from your graveyard; each one pays for {1}.",
    "Dredge": "Instead of drawing a card, you may mill that many cards and return this card from your graveyard to your hand.",
    "Echo": "On your next turn you must pay its cost again, or sacrifice it.",
    "Embalm": "Exile the card from your graveyard to create a token copy of it (a white Zombie mummy).",
    "Encore": "Exile it from your graveyard: for each opponent, create a copy with haste that must attack that player; sacrificed at end of turn.",
    "Escape": "You may cast the card from your graveyard by paying its escape cost and exiling other cards from your graveyard.",
    "Eternalize": "Exile the card from your graveyard to create a 4/4 token copy of it.",
    "Evoke": "Can be cast for its alternative cost – then it's sacrificed as it enters, but its effect still happens.",
    "Exalted": "When one of your creatures attacks alone, it gets +1/+1 until end of turn for each card with exalted.",
    "Extort": "Whenever you cast a spell, you may pay {W/B}: each opponent loses 1 life and you gain that much.",
    "Flashback": "You can cast the card a second time from your graveyard; then it's exiled.",
    "Foretell": "On your turn, exile the card face down for {2} and cast it later for less.",
    "Hideaway": "As it enters, exile one of your top cards face down; once a condition is met you may play it for free.",
    "Improvise": "Each artifact you tap while casting it pays for {1}.",
    "Infect": "Deals damage to creatures as -1/-1 counters and to players as poison counters (10 poison counters = you lose).",
    "Kicker": "An optional extra cost when you cast it – pay it and the effect gets stronger.",
    "Madness": "When you discard the card, you may cast it right away for its madness cost.",
    "Miracle": "If it's the first card you draw this turn, you may cast it right away for its miracle cost.",
    "Mutate": "Cast it for its mutate cost onto one of your non-Human creatures: they merge and have all their abilities together.",
    "Myriad": "When it attacks, create an attacking copy for each other opponent; the copies are exiled at end of combat.",
    "Ninjutsu": "Pay the cost and return an unblocked attacker to your hand: this card enters tapped and attacking.",
    "Partner": "Two commanders with partner can lead your deck together; the color identity is that of both cards.",
    "Persist": "When it dies without a -1/-1 counter, it returns to the battlefield with a -1/-1 counter.",
    "Poisonous": "When it deals combat damage to a player, that player gets the given number of poison counters.",
    "Prowess": "Whenever you cast a noncreature spell, it gets +1/+1 until end of turn.",
    "Rebound": "Cast from your hand, the spell is exiled and you may cast it again for free at the start of your next turn.",
    "Riot": "Choose as it enters: a +1/+1 counter or haste.",
    "Scavenge": "Exile the creature from your graveyard to put +1/+1 counters equal to its power on a creature.",
    "Split second": "While this spell is on the stack, nobody can cast spells or activate abilities.",
    "Storm": "When you cast it, copy the spell for each spell cast before it this turn.",
    "Suspend": "Exile the card with time counters; one comes off each turn, and when the last one does you cast it for free.",
    "Toxic": "When it deals combat damage to a player, that player also gets that many poison counters.",
    "Undying": "When it dies without a +1/+1 counter, it returns to the battlefield with a +1/+1 counter.",
    "Unearth": "Return the creature from your graveyard with haste (only as a sorcery); it's exiled at end of turn.",
    "Wither": "Deals damage to creatures in the form of -1/-1 counters.",
    "Landfall": "Triggers whenever a land enters under your control.",
    "Eminence": "Works while your commander is in the command zone – not only once it's on the battlefield.",
    "Lieutenant": "An extra effect as long as you control your commander.",
    "Melee": "When it attacks, it gets +1/+1 for each opponent you attacked this turn.",
    "Blitz": "Cast it for its blitz cost: haste, you draw a card when it dies, and it's sacrificed at end of turn.",
    "Casualty": "As you cast it, you may sacrifice a creature with at least the given power to copy the spell.",
    "Commander": "The legendary creature (or other allowed card) your deck is built around. It starts in the command zone.",
    "Command zone": "Where your commander starts. You cast it from there; when it dies or is exiled, you may put it back.",
    "Commander tax": "Each further time you cast your commander from the command zone, it costs {2} more.",
    "Commander damage": "A player who has taken 21 or more combat damage from the same commander loses the game.",
    "Color identity": "All colors in the commander's costs and rules text. Every card in the deck must fit these colors.",
    "Singleton": "Each card may be in the deck only once – except basic lands and cards that say otherwise.",
    "Bracket": "Official levels 1–5 for a deck's power, so decks of similar strength play together.",
    "Game Changer": "Official list of especially strong cards. Brackets 1–2 allow none, bracket 3 up to three.",
    "Rule 0": "The talk before the game: how strong are the decks, what's welcome and what isn't?",
    "Ramp": "Cards that give you more mana sooner (extra lands, mana rocks) – so you play expensive cards earlier.",
    "Card draw": "Cards that let you draw extra cards, so you don't run out of options.",
    "Removal": "Cards that get rid of a single threat (destroy, exile or bounce it).",
    "Board wipe": "Clears many or all creatures (or other permanents) at once – the emergency brake against big armies.",
    "Tutor": "A card that searches your library for a specific other card – makes decks very consistent.",
    "Win condition": "How your deck actually wins the game – big attackers, life drain or a combo, for example.",
    "Combo": "Two or more cards that together make a very strong or infinite effect.",
    "Mulligan": "Draw a new opening hand. In Commander the first mulligan is free; after that you put one card on the bottom per mulligan.",
    "Proxy": "A self-printed stand-in for a card. Usually fine in casual games – ask first.",
    "Stax": "Cards that restrict every player (spells cost more, fewer permanents untap). Not every playgroup likes them.",
    "Voltron": "Play style: make your commander huge with Auras and Equipment and win through commander damage.",
    "Aristocrats": "Play style: sacrifice your own creatures and gain something each time one dies (drain life, draw cards).",
    "Go wide": "Play style: lots of small creatures or tokens, and make them all stronger together.",
    "Reanimator": "Play style: put big creatures into your graveyard and bring them back cheaply.",
    "Spellslinger": "Play style: lots of instants and sorceries that give you something every time you cast one.",
    "Blink": "Play style: exile your creatures for a moment and bring them back to trigger their enter effects again.",
    "Group Hug": "Play style: help every player (cards, mana) and win through politics or a late turnaround.",
}


def _entry(term: str) -> dict[str, Any]:
    de, text, kind = TERMS[term]
    return {"term": term, "de": de, "text": text, "text_en": TEXT_EN[term], "kind": kind}


def entries() -> list[dict[str, Any]]:
    return [_entry(t) for t in TERMS]


def _pattern(word: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w-]){re.escape(word)}(?![\w-])", re.IGNORECASE)


_PATTERNS = [(t, _pattern(t)) for t in TERMS] + [(t, _pattern(de)) for t, (de, _, _) in TERMS.items() if de]


def find_terms(*texts: str, keywords: list[str] | None = None) -> list[dict[str, Any]]:
    """Glossary entries whose English or German name appears in the texts (plus Scryfall keywords)."""
    hits: dict[str, None] = {}
    for kw in keywords or []:
        match = next((t for t in TERMS if t.lower() == kw.lower()), None)
        if match:
            hits[match] = None
    blob = "\n".join(t for t in texts if t)
    for term, pat in _PATTERNS:
        if TERMS[term][2] == _C and term not in ("Monarch", "Initiative"):
            continue  # concepts are explained on the glossary page, not highlighted in card text
        if pat.search(blob):
            hits[term] = None
    return [_entry(t) for t in hits]
