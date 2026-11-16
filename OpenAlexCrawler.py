from OpenAlex import OpenAlex
from Mongo import MongoDB
from StateFile import StateFile
import sys
import time
from datetime import datetime, timedelta

# Ciência da Computação = fields/17; type:article restringe a artigos.
FILTER = "primary_topic.field.id:17,type:article"
SELECT = ",".join([
    "id",
    "doi",
    "display_name",
    "publication_year",
    "publication_date",
    "type",
    "language",
    "cited_by_count",
    "referenced_works",
    "referenced_works_count",
    "authorships",
    "primary_topic",
    "topics",
    "keywords",
    "open_access",
    "primary_location",
])

PER_PAGE = 100
STATE_FILE = "openalex_state.json"
MONGO_DB = "ArticleCrawler"


def shortId(value):
    return str(value).rsplit("/", 1)[-1]


def processWork(work):
    authors = []
    institutions = []
    for authorship in work.get("authorships") or []:
        author = (authorship.get("author") or {}).get("display_name")
        if author:
            authors.append(author)

        for institution in authorship.get("institutions") or []:
            name = institution.get("display_name")
            if name:
                institutions.append(name)

    return {
        "id": shortId(work["id"]),
        "openalex_id": work["id"],
        "doi": work.get("doi"),
        "title": work.get("display_name"),
        "publication_year": work.get("publication_year"),
        "publication_date": work.get("publication_date"),
        "type": work.get("type"),
        "language": work.get("language"),
        "cited_by_count": work.get("cited_by_count"),
        "referenced_works_count": work.get("referenced_works_count"),
        "referenced_works": [shortId(ref) for ref in work.get("referenced_works") or []],
        "authors": authors,
        "institutions": institutions,
        "topics": [topic["display_name"] for topic in work.get("topics") or []],
        "keywords": [keyword["display_name"] for keyword in work.get("keywords") or []],
        "primary_topic": (work.get("primary_topic") or {}).get("display_name"),
        "source": ((work.get("primary_location") or {}).get("source") or {}).get("display_name"),
        "is_oa": (work.get("open_access") or {}).get("is_oa"),
        "oa_url": (work.get("open_access") or {}).get("oa_url"),
        "landing_page_url": (work.get("primary_location") or {}).get("landing_page_url"),
        "pdf_url": (work.get("primary_location") or {}).get("pdf_url"),
    }


def saveWorks(batch):
    if not batch:
        return 0

    return mongo.insertManyWorks(batch)


def saveState(cursor, total, lastWorkId, totalAvailable, finished=False):
    stateFile.state["cursor"] = cursor
    stateFile.state["totalFetched"] = total
    stateFile.state["lastWorkId"] = lastWorkId
    stateFile.state["totalAvailable"] = totalAvailable
    stateFile.state["filter"] = FILTER
    stateFile.state["finished"] = finished
    stateFile.save()


if __name__ == "__main__":
    stateFile = StateFile(STATE_FILE)

    if stateFile.state.get("filter") not in (None, FILTER):
        print("O filtro mudou; reiniciando do começo.")
        stateFile.state.update({"cursor": "", "totalFetched": 0, "finished": False, "totalAvailable": 0})

    if stateFile.state.get("finished"):
        print(f"Crawl já concluído. Artigos processados: {stateFile.state.get('totalFetched', 0)}")
        sys.exit(0)

    cursor = stateFile.state.get("cursor") or "*"
    total = int(stateFile.state.get("totalFetched", 0) or 0)
    lastWorkId = stateFile.state.get("lastWorkId", "")
    totalEst = int(stateFile.state.get("totalAvailable", 0) or 0)
    avgTime = 0

    oa = OpenAlex(api_key='GRfXUs1Gr5kYWu8jDdhVQ8')
    mongo = MongoDB(MONGO_DB)

    print("== OpenAlex -> Mongo ==")
    print(f"Filtro: {FILTER}")
    print(f"Cursor inicial: {'*' if cursor == '*' else cursor[:28] + '...'}")
    print(f"Total já processado: {total}")

    while True:
        pageStart = time.time()

        try:
            works = oa.getWorks(
                filter=FILTER,
                per_page=PER_PAGE,
                cursor=cursor,
                select=SELECT,
            )
        except Exception as e:
            saveState(cursor, total, lastWorkId, totalEst)
            print(f"Erro ao consultar OpenAlex: {e}")
            print("Estado salvo.")
            break

        status = oa.lastResponse.status_code

        if status == 429:
            headers = oa.lastResponse.headers
            remaining = headers.get("X-RateLimit-Remaining")
            body = str(works).lower()
            daily = (remaining is not None and float(remaining) <= 0) or "credit" in body or "daily" in body

            if daily:
                stateFile.state["dailyLimitReachedAt"] = int(time.time())
                saveState(cursor, total, lastWorkId, totalEst)
                print("Limite diário atingido. Estado salvo.")
                reset = headers.get("X-RateLimit-Reset")
                if reset:
                    print(f"Reset do budget em ~{int(float(reset)) / 3600:.1f}h.")
                break

            wait = max(1.0, float(headers.get("Retry-After", 60)))
            print(f"Rate limit; aguardando {wait:.0f}s...")
            time.sleep(wait)
            continue

        if status != 200:
            saveState(cursor, total, lastWorkId, totalEst)
            print(f"OpenAlex HTTP {status}: {works}")
            print("Estado salvo.")
            break

        meta = works.get("meta") or {}
        results = works.get("results") or []
        totalEst = int(meta.get("count") or totalEst or 0)

        try:
            batch = [processWork(work) for work in results]
            saveWorks(batch)
        except Exception as e:
            saveState(cursor, total, lastWorkId, totalEst)
            print(f"Erro ao processar/salvar artigos: {e}")
            print("Estado salvo.")
            break

        total += len(batch)
        if results:
            lastWorkId = shortId(results[-1]["id"])

        nextCursor = meta.get("next_cursor")
        if not nextCursor:
            saveState("", total, lastWorkId, totalEst, finished=True)
            print(f"Crawl concluído. Artigos processados: {total}")
            break

        saveState(nextCursor, total, lastWorkId, totalEst)
        cursor = nextCursor

        pageTime = time.time() - pageStart
        avgTime = (avgTime * 0.9) + (pageTime * 0.1) if avgTime > 0 else pageTime

        remainingWorks = max(0, totalEst - total)
        eta = (datetime.now() + timedelta(seconds=(avgTime / PER_PAGE) * remainingWorks)).strftime("%Y-%m-%d %H:%M:%S")
        credits = oa.lastResponse.headers.get("X-RateLimit-Remaining")

        print(
            f"Total: {total}/{totalEst} | "
            f"LastWork: {lastWorkId} | "
            f"Credits: {credits if credits is not None else '?'} | "
            f"AvgPage: {avgTime:.2f}s | ETA: {eta}"
        )

        if credits is not None and float(credits) <= 0:
            stateFile.state["dailyLimitReachedAt"] = int(time.time())
            saveState(cursor, total, lastWorkId, totalEst)
            print("Budget diário esgotado após esta página. Estado salvo.")
            break
