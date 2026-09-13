from Wikipedia import Wikipedia
from StateFile import StateFile
from Mongo import MongoDB
import time
import urllib
import threading
import random
from datetime import datetime, timedelta
from queue import Queue
from concurrent.futures import ThreadPoolExecutor

CHUNK_SIZE = 50
MAX_WORKERS = 5
mongoQueue = Queue(maxsize=100)
totalEst = 7000000
avgTime = 0

def threadMongoInsertions():
    while True:
        items = mongoQueue.get()
        if items is None:
            mongoQueue.task_done()
            break
        mongo.insertManyWikis(items)
        mongoQueue.task_done()

def processBeforeInsertion(wikiPageRaw):
    try:
        content = wikiPageRaw["revisions"][0]["slots"]["main"]["content"]
    except:
        return None

    if content.startswith("#REDIRECIONAMENTO"):
        return None

    wikiPageRaw["linkedPages"] = Wikipedia.getWikisRelated(content)
    del wikiPageRaw["revisions"]

    return wikiPageRaw

def fetch_and_process_chunk(chunk, w, max_retries=5):
    titles = "|".join(urllib.parse.quote(wiki["title"]) for wiki in chunk)

    for attempt in range(max_retries):
        try:
            time.sleep(random.uniform(0.1, 0.5))

            wikiPages = w.getWiki(
                action="query",
                titles=titles,
                prop="info|revisions",
                inprop="url",
                rvprop="content",
                rvslots="main",
                format="json",
                formatversion="2"
            )

            if "error" in wikiPages:
                raise Exception(f"API Error: {wikiPages['error'].get('info', 'Unknown')}")

            return list(filter(
                lambda e: e is not None,
                [processBeforeInsertion(p) for p in wikiPages.get("query", {}).get("pages", [])]
            ))

        except Exception as e:
            if attempt == max_retries - 1:
                print(f"Failed to fetch chunk after {max_retries} attempts. Skipping.")
                return []

            sleep_time = 2 ** attempt
            print(f"Rate limited or error. Retrying in {sleep_time}s... (Error: {e})")
            time.sleep(sleep_time)

if __name__ == "__main__":
    prefixLetters = "b,c,d,f,g,h,j,k,l,m,n,p,q,r,s,t,v,w,x,y,z".split(",")

    w = Wikipedia("pt")
    mongo = MongoDB("wikipediaCrawler")
    stateFile = StateFile("state.json")

    mongoThread = threading.Thread(name="MongoThread", target=threadMongoInsertions)
    mongoThread.start()

    prefixLetter = str(stateFile.getPrefixLetter()).strip().lower()

    if prefixLetter == "":
        prefixLetter = prefixLetters.pop(0).strip()[0].lower()
        stateFile.setPrefixLetter(prefixLetter)
        stateFile.save()
    elif prefixLetter[0] in prefixLetters:
        while prefixLetter[0] != prefixLetters.pop(0).strip()[0].lower():
            pass
    else:
        print("The starting letter saved in state is not in prefixLetters array!")
        exit(1)

    lastWikiTitle = stateFile.getLastWikiTitle()
    total = stateFile.getTotal()
    apcontinue = lastWikiTitle

    print(f"== Inserting.. ==")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        while True:
            wikiList = w.getWiki(
                action="query",
                list="allpages",
                aplimit="500",
                apprefix=prefixLetter,
                apcontinue=apcontinue,
                apfilterredir="nonredirects",
                format="json",
                formatversion="2"
            )

            flatWikiList = wikiList["query"]["allpages"]
            chunks = [flatWikiList[i:i+CHUNK_SIZE] for i in range(0, len(flatWikiList), CHUNK_SIZE)]

            lastTime = datetime.now()

            results = executor.map(lambda c: fetch_and_process_chunk(c, w), chunks)

            for index, wikiPages in enumerate(results):
                if wikiPages:
                    mongoQueue.put(wikiPages)
                    lastWikiTitle = wikiPages[-1].get("title", "")

                wikiPagesSize = len(wikiPages)
                total += wikiPagesSize

                if wikiPagesSize > 0:
                    pages_remaining = totalEst - total
                    totalSecondsRemaining = (avgTime / wikiPagesSize) * pages_remaining if wikiPagesSize > 0 else 0
                    eta = (datetime.now() + timedelta(seconds=int(totalSecondsRemaining))).strftime("%Y-%m-%d %H:%M:%S")
                    print(f"Total: {total} | PartTitle: {apcontinue} | LastWikiInserted: {lastWikiTitle} | MongoThread: {('Live' if mongoThread.is_alive() else 'Dead')} | AvgTime: {avgTime:.2f}s | ETA: {eta}")

                if index % 10 == 0:
                    stateFile.setTotal(total)
                    stateFile.setLastWikiTitle(lastWikiTitle)
                    stateFile.save()

            cTime = (datetime.now() - lastTime).total_seconds() / len(chunks) if chunks else 0
            avgTime = (avgTime * 0.9) + (cTime * 0.1) if avgTime > 0 else cTime

            if "continue" not in wikiList:
                print(f"End of wikis starting with {str(prefixLetter)}")
                if len(prefixLetters) == 0:
                    mongoQueue.put(None)
                    break

                prefixLetter = prefixLetters.pop(0).strip()[0].lower()
                stateFile.setPrefixLetter(prefixLetter)
                stateFile.save()
                print(f"Starting the wikis with {str(prefixLetter)}")
                apcontinue = ""
            else:
                apcontinue = wikiList["continue"]["apcontinue"]

    mongoThread.join()
