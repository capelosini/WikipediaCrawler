from Wikipedia import Wikipedia

if __name__ == "__main__":
    w = Wikipedia("pt")
    wikiPages = w.getWiki(
        action="query"
        ,titles="Eletrônica|Circuito_digital"
        ,prop="info|revisions"
        ,inprop="url"
        ,rvprop="content"
        ,rvslots="main"
        ,format="json"
        ,formatversion="2"
    )

    print(w.getWikisRelated(wikiPages["query"]["pages"][0]["revisions"][0]["slots"]["main"]["content"]))
