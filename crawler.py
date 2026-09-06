from Wikipedia import Wikipedia
import time
import urllib

CHUNK_SIZE = 50

if __name__ == "__main__":
    prefixLetter = "a"

    w = Wikipedia("pt")
    apcontinue = ""
    while True:
        wikiList = w.getWiki(
            action="query",
            list="allpages",
            aplimit="500",
            apprefix=prefixLetter,
            apcontinue="",
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
            
            print('\t'.join(wiki["title"] for wiki in wikiPages["query"]["pages"]))
            time.sleep(.5)

        if not wikiList["continue"]["apcontinue"]:
            print("fim das wikis começadas com ", prefixLetter)
            break
        apcontinue=wikiList["continue"]["apcontinue"]
