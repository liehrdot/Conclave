"use strict";
// The desktop GUI, part 21 of 21: start-up: wire the inputs, load the lists, route.
// index.html loads the parts in order; they share one global scope.

wireAutocomplete($("#bl-input"), $("#ac-bl"));
wireAutocomplete($("#tr-input"), $("#ac-tr"));
wireAutocomplete($("#opp-new [name=commander]"), $("#ac-opp-new"));
wireAutocomplete($("#opp-form [name=commander]"), $("#ac-opp-edit"));
wireAutocomplete($("#opp-form [name=partner]"), $("#ac-opp-partner"));
void refreshBlacklist();
loadSettings().catch((err) => console.error(err));
Promise.all([initBrackets(), refreshDeckList(), refreshCollectionSummary(), refreshTableRules(), refreshOpponents(), refreshSales()]).then(route, (err) => { fail(err); void route(); });
void refreshSync({ quiet: true });
// the desktop shell polls the backend a few seconds after the start; sooner after an update, to report how it went
setTimeout(refreshDesktop, store.get("update") ? 4000 : 20000);
