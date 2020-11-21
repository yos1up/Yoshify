let isActive = false
chrome.browserAction.onClicked.addListener(function(tab){
	isActive = !isActive
	if (isActive){
		chrome.browserAction.setIcon({path:"images/icon_on.png"})
	}else{
		chrome.browserAction.setIcon({path:"images/icon_off.png"})
	}
    chrome.tabs.getSelected(null, function(tab){
        var param = {isActive}
        chrome.tabs.sendRequest(tab.id, param, function(response){
            console.log("Request sent to tab.")
        });
    });
});