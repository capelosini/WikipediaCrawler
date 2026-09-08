import json
from datetime import datetime
import os

STATE_FILE_DEFAULT = {
    "total": 0
    ,"lastWikiTitle": ""
    ,"prefixLetter": ""
    ,"savedAt": 0
}

class StateFile:
    def __init__(self, filename: str = "state.json"):
        self.filename = filename
        # defaults
        self.state = STATE_FILE_DEFAULT
        if os.path.exists(filename):
            with open(filename, "r+") as f:
                data = f.read()
            try:
                j = json.loads(data)
                for k in list(j.keys()):
                    self.state[k] = j[k]
            except:
                pass


    def save(self):
        self.state['savedAt'] = int(datetime.now().timestamp())
        f = open(self.filename, "w+")
        f.write(json.dumps(self.state))
        f.close()

    def _getField(self, field: str):
        return self.state.get(field, STATE_FILE_DEFAULT.get(field))

    def setPrefixLetter(self, prefixLetter: str):
        self.state["prefixLetter"]=prefixLetter

    def getPrefixLetter(self):
        return self._getField("prefixLetter")

    def setTotal(self, total: int):
        self.state["total"]=total

    def getTotal(self):
        return self._getField("total")

    def setLastWikiTitle(self, lastWikiTitle: str):
        self.state["lastWikiTitle"] = lastWikiTitle

    def getLastWikiTitle(self):
        return self._getField("lastWikiTitle")
