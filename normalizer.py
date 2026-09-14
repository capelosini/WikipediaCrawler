from neo4j import GraphDatabase
from Mongo import MongoDB
from StateFile import StateFile

class NeoForJ:
    def __init__(self, auth, host="localhost", port=7687, database="neo4j"):
        self.URI = f"bolt://{host}:{port}"
        self.AUTH = auth
        self.database = database
        self._setup()

    def _setup(self):
        self.driver = GraphDatabase.driver(uri=self.URI, auth=self.AUTH)
        self.driver.verify_connectivity()

    def execQuery(self, query: str, **kwargs):
        return self.driver.execute_query(query, database_=self.database, **kwargs)

    def getNodesCount(self):
        query = """
        MATCH(n) RETURN count(n) AS total
        """
        return self.execQuery(query).records[0]['total']

    def bulkNodes(self, batch):
        bulkQuery = """
        UNWIND $batch AS data

        MERGE(page:Page {title: data.title})
        SET page.connections = data.out_degree

        WITH data, page
        UNWIND data.links AS link_title
        MERGE(link:Page {title: link_title})

        MERGE (page)-[:LINKS]->(link)
        """

        self.execQuery(bulkQuery, batch=batch)

if __name__ == "__main__":
    mongo = MongoDB("wikipediaCrawler")
    neo = NeoForJ(("neo4j", "testpass"))
    state = StateFile("normalize_track.json")


    addIndex = """
    CREATE CONSTRAINT unique_page_title IF NOT EXISTS
    FOR (p:Page) REQUIRE p.title IS UNIQUE;
    """
    neo.execQuery(addIndex)

    checkpoint = state.getLastWikiTitle()
    batches = mongo.getWikiBatches(batch_size=5000, checkpoint_id=checkpoint)
    for index, batch in enumerate(batches):
        state.setLastWikiTitle(batch[0]["_id"])
        state.setTotal(index*len(batch)+len(batch))
        print(f"Passadas {index*len(batch)+len(batch)} páginas")
        neo.bulkNodes(batch)
        state.save()
