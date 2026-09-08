from Wikipedia import Wikipedia
from StateFile import StateFile
from Mongo import MongoDB
import time
import urllib

CHUNK_SIZE = 50

def processBeforeInsertion(wikiPageRaw):
    try:
        content = wikiPageRaw["revisions"][0]["slots"]["main"]["content"]
    except:
        return None

    # just remove this, if we dont want to remove REDIRECTIONS
    if content.startswith("#REDIRECIONAMENTO"):
        return None

    # Add the linked pages
    wikiPageRaw["linkedPages"] = Wikipedia.getWikisRelated(content)

    # I will remove the content so that we dont insert it to the Database, we'll not use it
    del wikiPageRaw["revisions"]

    return wikiPageRaw

if __name__ == "__main__":
    prefixLetters = ["a", "e", "i", "o", "u"]

    w = Wikipedia("pt")
    stateFile = StateFile("state.json")

    prefixLetter = str(stateFile.getPrefixLetter()).strip().lower()
    if prefixLetter == "":
        # just pick the first letter
        prefixLetter = prefixLetters.pop(0).strip()[0].lower()
        stateFile.setPrefixLetter(prefixLetter)
        stateFile.save()
    elif prefixLetter[0] in prefixLetters:
        # lets sync our prefixLetters array with the saved state
        while prefixLetter[0] != prefixLetters.pop(0).strip()[0].lower():
            pass
    else:
        print("The starting letter saved in state is not in prefixLetters array!")
        exit(1)

    lastWikiTitle=stateFile.getLastWikiTitle()
    total=stateFile.getTotal()
    apcontinue = lastWikiTitle

    print(f"== Inserting.. ==")
    while True:
        wikiList = w.getWiki(
            action="query",
            list="allpages",
            aplimit="500",
            apprefix=prefixLetter,
            apcontinue=apcontinue,
            format="json",
            formatversion="2"
        )

        flatWikiList = wikiList["query"]["allpages"]

        for i in range(0, len(flatWikiList), CHUNK_SIZE):
            chunk = flatWikiList[i:i+CHUNK_SIZE]
            titles = "|".join(urllib.parse.quote(wiki["title"]) for wiki in chunk)
            wikiPages = w.getWiki(
                    action="query"
                    ,titles=titles
                    ,prop="info|revisions"
                    ,inprop="url"
                    ,rvprop="content"
                    ,rvslots="main"
                    ,format="json"
                    ,formatversion="2"
                )
            # alguns objetos q retornam em wikiPages["query"]["pages"] podem ser redirecionamento p outras paginas, dá pegar esse redrecionamento adicionando &redirects=1 ou ignorar eles só verificando se o ["content"] começa com '#REDIRECT'
            wikiPages = list(filter(
                lambda e: e is not None
                ,[processBeforeInsertion(p) for p in wikiPages["query"]["pages"]]
            ))

            # TODO! Insert the wikiPages into the mongodb database using the MongoDB class

            total += len(wikiPages)
            lastWikiTitle = wikiPages[-1].get("title", "")
            print(f"Total: {total} | PartTitle: {apcontinue} | LastWikiInserted: {lastWikiTitle}{' '*30}", end="\r")

            stateFile.setTotal(total)
            stateFile.setLastWikiTitle(lastWikiTitle)
            stateFile.save()

            time.sleep(.5)

        if not wikiList["continue"]["apcontinue"]:
            print(f"End of wikis starting with {str(prefixLetter)}")
            if len(prefixLetters) == 0:
                break
            prefixLetter = prefixLetters.pop(0).strip()[0].lower()
            stateFile.setPrefixLetter(prefixLetter)
            stateFile.save()
            print(f"Starting the wikis with {str(prefixLetter)}")

        apcontinue=wikiList["continue"]["apcontinue"]
