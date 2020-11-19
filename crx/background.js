chrome.browserAction.onClicked.addListener(function(tab){
    chrome.tabs.getSelected(null, function(tab){
        var param = {};
        chrome.tabs.sendRequest(tab.id, param, function(response){
            console.log("Request sent to tab.");
        });
    });
});