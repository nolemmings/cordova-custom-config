#!/usr/bin/env node

/**********
 * Globals
 **********/
// Pre-existing Cordova npm modules
var deferral, path, cwd;

// Npm dependencies
var logger,
    fs,
    _ ,
    et,
    plist,
    xcode,
    tostr,
    fileUtils;

// Other globals
var hooksPath;

var applyCustomConfig = (function(){

    /**********************
     * Internal properties
     *********************/
    var applyCustomConfig = {}, rootdir, context, configXml, projectName, settings = {}, updatedFiles = {};

    var androidActivityNames = [
        "CordovaApp",  // Cordova <= 4.2.0
        "MainActivity" // Cordova >= 4.3.0
    ];

    // Tags that can appear multiple times in the <root> manifest, so must be distinguished by name
    var androidRootMultiples = ["uses-permission", "permission", "permission-tree", "permission-group", "instrumentation", "uses-sdk", "uses-configuration", "uses-feature", "supports-screens", "compatible-screens", "supports-gl-texture"];

    var xcconfigs = ["build.xcconfig", "build-extras.xcconfig", "build-debug.xcconfig", "build-release.xcconfig"];

    var preferencesData;


    /*********************
     * Internal functions
     *********************/

    // Converts an elementtree object to an xml string.  Since this is used for plist values, we don't care about attributes
    function eltreeToXmlString(data) {
        var tag = data.tag;
        var el = '<' + tag + '>';

        if(data.text && data.text.trim()) {
            el += data.text.trim();
        } else {
            _.each(data.getchildren(), function (child) {
                el += eltreeToXmlString(child);
            });
        }

        el += '</' + tag + '>';
        return el;
    }


    /* Retrieves all <preferences ..> from config.xml and returns a map of preferences with platform as the key.
     *  If a platform is supplied, common prefs + platform prefs will be returned, otherwise just common prefs are returned.
     */
    function getPlatformPreferences(platform) {
        //init common config.xml prefs if we haven't already
        if(!preferencesData) {
            preferencesData = {
                common: configXml.findall('preference')
            };
        }

        var prefs = preferencesData.common || [];
        if(platform) {
            if(!preferencesData[platform]) {
                preferencesData[platform] = configXml.findall('platform[@name=\'' + platform + '\']/preference');
            }
            prefs = prefs.concat(preferencesData[platform]);
        }

        return prefs;
    }

    /* Retrieves all configured xml for a specific platform/target/parent element nested inside a platforms config-file
     element within the config.xml.  The config-file elements are then indexed by target|parent so if there are
     any config-file elements per platform that have the same target and parent, the last config-file element is used.
     */
    function getConfigFilesByTargetAndParent(platform) {
        var configFileData = configXml.findall('platform[@name=\'' + platform + '\']/config-file');
        return  _.keyBy(configFileData, function(item) {
            var parent = item.attrib.parent;
            //if parent attribute is undefined /* or */, set parent to top level elementree selector
            if(!parent || parent === '/*' || parent === '*/') {
                parent = './';
            }
            return item.attrib.target + '|' + parent;
        });
    }

    // Parses the config.xml's preferences and config-file elements for a given platform
    function parseConfigXml(platform) {
        var configData = {};
        parsePlatformPreferences(configData, platform);
        parseConfigFiles(configData, platform);

        return configData;
    }

    // Retrieves the config.xml's pereferences for a given platform and parses them into JSON data
    function parsePlatformPreferences(configData, platform) {
        var preferences = getPlatformPreferences(platform);
        switch(platform){
            case "ios":
                parseiOSPreferences(preferences, configData, platform);
                break;
            case "android":
                parseAndroidPreferences(preferences, configData, platform);
                break;
        }
    }

    // Parses iOS preferences into project.pbxproj
    function parseiOSPreferences(preferences, configData, platform){
        _.each(preferences, function (preference) {
            if(preference.attrib.name.match(new RegExp("^"+platform+"-"))){
                var parts = preference.attrib.name.split("-"),
                    target = "project.pbxproj",
                    prefData = {
                        type: parts[1],
                        name: parts[2],
                        value: preference.attrib.value
                    };
                if(preference.attrib.buildType){
                    prefData["buildType"] = preference.attrib.buildType;
                }
                if(preference.attrib.quote){
                    prefData["quote"] = preference.attrib.quote;
                }

                prefData["xcconfigEnforce"] = preference.attrib.xcconfigEnforce ? preference.attrib.xcconfigEnforce : null;

                if(!configData[target]) {
                    configData[target] = [];
                }
                configData[target].push(prefData);
            }
        });
    }

    // Parses supported Android preferences using the preference mapping into the appropriate XML elements in AndroidManifest.xml
    function parseAndroidPreferences(preferences, configData, platform){
        var type = 'preference';

        _.each(preferences, function (preference) {
            // Extract pre-defined preferences (deprecated)
            var target,
                prefData;

            if(preference.attrib.name.match(/^android-manifest\//)){
                // Extract manifest Xpath preferences
                var parts = preference.attrib.name.split("/"),
                    destination = parts.pop();
                parts.shift();

                prefData = {
                    parent: parts.join("/") || "./",
                    type: type,
                    destination: destination,
                    data: preference
                };
                target = "AndroidManifest.xml";
            }

            if(prefData){
                if(!configData[target]) {
                    configData[target] = [];
                }
                configData[target].push(prefData);
            }
        });
    }

    // Retrieves the config.xml's config-file elements for a given platform and parses them into JSON data
    function parseConfigFiles(configData, platform) {
        var configFiles = getConfigFilesByTargetAndParent(platform),
            type = 'configFile';

        _.each(configFiles, function (configFile, key) {
            var keyParts = key.split('|');
            var target = keyParts[0];
            var parent = keyParts[1];
            var items = configData[target] || [];

            _.each(configFile.getchildren(), function (element) {
                items.push({
                    parent: parent,
                    type: type,
                    destination: element.tag,
                    data: element
                });
            });

            configData[target] = items;
        });
    }

    // Updates the AndroidManifest.xml target file with data from config.xml
    function updateAndroidManifest(targetFilePath, configItems) {
        var tempManifest = fileUtils.parseElementtreeSync(targetFilePath),
            root = tempManifest.getroot();

        _.each(configItems, function (item) {
            // if parent is not found on the root, child/grandchild nodes are searched
            var parentEl = root.find(item.parent) || root.find('*/' + item.parent),
                parentSelector,
                data = item.data,
                childSelector = item.destination,
                childEl;

            _.each(androidActivityNames, function(activityName){
                if(parentEl){
                    return;
                }
                parentSelector = item.parent.replace("{ActivityName}", activityName);
                parentEl = root.find(parentSelector) || root.find('*/' + parentSelector);
            });

            if(!parentEl) {
                return;
            }

            if(item.type === 'preference') {
                parentEl.attrib[childSelector.replace("@",'')] = data.attrib['value'];

            } else {
                //  if there can be multiple sibling elements, we need to select them by unique name
                if(androidRootMultiples.indexOf(childSelector > -1)){
                    childSelector += '[@android:name=\'' + data.attrib['android:name'] + '\']';
                }

                childEl = parentEl.find(childSelector);
                // if child element doesnt exist, create new element
                if(!childEl) {
                    childEl = new et.Element(item.destination);
                    parentEl.append(childEl);
                }

                // copy all config.xml data except for the generated _id property
                _.each(data, function (prop, propName) {
                    if(propName !== '_id') {
                        childEl[propName] = prop;
                    }
                });
            }
        });
        fs.writeFileSync(targetFilePath, tempManifest.write({indent: 4}), 'utf-8');
    }
    // Updates target file with data from config.xml
    function updateWp8Manifest(targetFilePath, configItems) {
        var tempManifest = fileUtils.parseElementtreeSync(targetFilePath),
            root = tempManifest.getroot();
        _.each(configItems, function (item) {
            // if parent is not found on the root, child/grandchild nodes are searched
            var parentEl = root.find(item.parent) || root.find('*/' + item.parent),
                parentSelector,
                data = item.data,
                childSelector = item.destination,
                childEl;
            if(!parentEl) {
                return;
            }

            _.each(data.attrib, function (prop, propName) {
                childSelector += '[@'+propName+'="'+prop+'"]';
            });

            childEl = parentEl.find(childSelector);
            // if child element doesnt exist, create new element
            if(!childEl) {
                childEl = new et.Element(item.destination);
                parentEl.append(childEl);
            }

            // copy all config.xml data except for the generated _id property
            _.each(data, function (prop, propName) {
                if(propName !== '_id') {
                    childEl[propName] = prop;
                }
            });

        });
        fs.writeFileSync(targetFilePath, tempManifest.write({indent: 4}), 'utf-8');
    }

    /* Updates the *-Info.plist file with data from config.xml by parsing to an xml string, then using the plist
     module to convert the data to a map.  The config.xml data is then replaced or appended to the original plist file
     */
    function updateIosPlist (targetFilePath, configItems) {
        var infoPlist = plist.parse(fs.readFileSync(targetFilePath, 'utf-8')),
            tempInfoPlist;

        _.each(configItems, function (item) {
            var key = item.parent;
            var plistXml = '<plist><dict><key>' + key + '</key>';
            plistXml += eltreeToXmlString(item.data) + '</dict></plist>';

            var configPlistObj = plist.parse(plistXml);
            infoPlist[key] = configPlistObj[key];
            logger.debug("Write to plist; key="+key+"; value="+tostr(configPlistObj[key]));
        });

        tempInfoPlist = plist.build(infoPlist);
        tempInfoPlist = tempInfoPlist.replace(/<string>[\s\r\n]*<\/string>/g,'<string></string>');
        fs.writeFileSync(targetFilePath, tempInfoPlist, 'utf-8');
    }

    /**
     * Updates the project.pbxproj file with data from config.xml
     * @param {String} xcodeProjectPath - path to XCode project file
     * @param {Array} configItems - config items to update project file with
     */
    function updateIosPbxProj(xcodeProjectPath, configItems) {
        var xcodeProject = xcode.project(xcodeProjectPath);
        xcodeProject.parse(function(err){
            if(err){
                shell.echo('An error occurred during parsing of [' + xcodeProjectPath + ']: ' + JSON.stringify(err));
            }else{
                _.each(configItems, function (item) {
                    switch(item.type){
                        case "XCBuildConfiguration":
                            var buildConfig = xcodeProject.pbxXCBuildConfigurationSection();
                            var replaced = updateXCBuildConfiguration(item, buildConfig, "replace");
                            if(!replaced){
                                updateXCBuildConfiguration(item, buildConfig, "add");
                            }
                            break;
                    }
                });
                fs.writeFileSync(xcodeProjectPath, xcodeProject.writeSync(), 'utf-8');
            }
        });
    }

    /**
     * Updates an XCode build configuration setting with the given item.
     * @param {Object} item - configuration item containing setting data
     * @param {Object} buildConfig - XCode build config object
     * @param {String} mode - update mode: "replace" to replace only existing keys or "add" to add a new key to every block
     * @returns {boolean} true if buildConfig was modified
     */
    function updateXCBuildConfiguration(item, buildConfig, mode){
        var modified = false;
        for(var blockName in buildConfig){
            var block = buildConfig[blockName];

            if(typeof(block) !== "object" || !(block["buildSettings"])) continue;
            var literalMatch = !!block["buildSettings"][item.name],
                quotedMatch = !!block["buildSettings"][quoteEscape(item.name)],
                match = literalMatch || quotedMatch;

            if((match || mode === "add") &&
                (!item.buildType || item.buildType.toLowerCase() === block['name'].toLowerCase())){

                var name;
                if(match){
                    name = literalMatch ? item.name : quoteEscape(item.name);
                }else{
                    // adding
                    name = (item.quote && (item.quote == "none" || item.quote == "value")) ? item.name : quoteEscape(item.name);
                }
                var value = (item.quote && (item.quote == "none" || item.quote == "key")) ? item.value : quoteEscape(item.value);

                block["buildSettings"][name] = value;
                modified = true;
                logger.debug(mode+" XCBuildConfiguration key={ "+name+" } to value={ "+value+" } for build type='"+block['name']+"' in block='"+blockName+"'");
            }
        }
        return modified;
    }

    /**
     * Checks if Cordova's .xcconfig files contain overrides for the given setting, and if so overwrites the value in the .xcconfig file(s).
     */
    function updateXCConfigs(configItems, platformPath){
        xcconfigs.forEach(function(fileName){
            updateXCConfig(platformPath, fileName, configItems)
        });
    }

    function updateXCConfig(platformPath, targetFileName, configItems){
        var modified = false,
            targetFilePath = path.join(platformPath, 'cordova', targetFileName);

        // Read file contents
        logger.debug("Reading "+targetFileName);
        var fileContents = fs.readFileSync(targetFilePath, 'utf-8');

        _.each(configItems, function (item) {
            // some keys have name===undefined; ignore these.
            if (item.name) {
                var escapedName = regExpEscape(item.name);
                var fileBuildType = "none";
                if(targetFileName.match("release")){
                    fileBuildType = "release";
                }else if(targetFileName.match("debug")){
                    fileBuildType = "debug";
                }

                var itemBuildType = item.buildType ? item.buildType.toLowerCase() : "none";

                var name = item.name;
                var value = item.value;

                var doReplace = function(){
                    fileContents = fileContents.replace(new RegExp("\n\"?"+escapedName+"\"?.*"), "\n"+name+" = "+value);
                    logger.debug("Overwrote "+item.name+" with '"+item.value+"' in "+targetFileName);
                    modified = true;
                };

                // If item's target build type matches the xcconfig build type
                if(itemBuildType === fileBuildType){
                    // If file contains the item, replace it with configured value
                    if(fileContents.match(escapedName) && item.xcconfigEnforce != "false"){
                        doReplace();
                    }else // presence of item is being enforced, so add it to the relevant .xcconfig
                    if(item.xcconfigEnforce == "true"){
                        fileContents += "\n"+name+" = "+value;
                        modified = true;
                    }
                }else
                // if item is a Debug CODE_SIGNING_IDENTITY, this is a special case: Cordova places its default Debug CODE_SIGNING_IDENTITY in build.xcconfig (not build-debug.xcconfig)
                // so if buildType="debug", want to overrwrite in build.xcconfig
                if(item.name.match("CODE_SIGN_IDENTITY") && itemBuildType == "debug" && fileBuildType == "none" && !item.xcconfigEnforce){
                    doReplace();
                }
            }
        });

        if(modified){
            ensureBackup(targetFilePath, 'ios', targetFileName);
            fs.writeFileSync(targetFilePath, fileContents, 'utf-8');
            logger.debug("Overwrote "+targetFileName);
        }

    }

    function regExpEscape(literal_string) {
        return literal_string.replace(/[-[\]{}()*+!<=:?.\/\\^$|#\s,]/g, '\\$&');
    }

    function quoteEscape(value){
        return '"'+value+'"';
    }


    function ensureBackup(targetFilePath, platform, targetFileName){
        var backupDirPath = path.join(cwd, 'plugins', context.opts.plugin.id, "backup"),
            backupPlatformPath = path.join(backupDirPath, platform),
            backupFilePath = path.join(backupPlatformPath, targetFileName);


        var backupDirExists = fileUtils.directoryExists(backupDirPath);
        if(!backupDirExists){
            fileUtils.createDirectory(backupDirPath);
            logger.debug("Created backup directory: "+backupDirPath);
        }

        var backupPlatformExists = fileUtils.directoryExists(backupPlatformPath);
        if(!backupPlatformExists){
            fileUtils.createDirectory(backupPlatformPath);
            logger.debug("Created backup platform directory: "+backupPlatformPath);
        }

        var backupFileExists = fileUtils.fileExists(backupFilePath);
        if(!backupFileExists){
            fs.copySync(targetFilePath, backupFilePath);
            logger.debug("Backed up "+targetFilePath+" to "+backupFilePath);
        }else{
            logger.debug("Backup exists for '"+targetFileName+"' at: "+backupFilePath);
        }

        if(!updatedFiles[targetFilePath]){
            logger.log("Applied custom config from config.xml to "+targetFilePath);
            updatedFiles[targetFilePath] = true;
        }
    }

    // Parses config.xml data, and update each target file for a specified platform
    function updatePlatformConfig(platform) {
        var configData = parseConfigXml(platform),
            platformPath = path.join(rootdir, 'platforms', platform);

        _.each(configData, function (configItems, targetFileName) {
            var targetFilePath;
            if (platform === 'ios') {
                if (targetFileName.indexOf("Info.plist") > -1) {
                    targetFileName =  projectName + '-Info.plist';
                    targetFilePath = path.join(platformPath, projectName, targetFileName);
                    ensureBackup(targetFilePath, platform, targetFileName);
                    updateIosPlist(targetFilePath, configItems);
                }else if (targetFileName === "project.pbxproj") {
                    targetFilePath = path.join(platformPath, projectName + '.xcodeproj', targetFileName);
                    ensureBackup(targetFilePath, platform, targetFileName);
                    updateIosPbxProj(targetFilePath, configItems);
                    updateXCConfigs(configItems, platformPath);
                }

            } else if (platform === 'android' && targetFileName === 'AndroidManifest.xml') {
                targetFilePath = path.join(platformPath, targetFileName);
                ensureBackup(targetFilePath, platform, targetFileName);
                updateAndroidManifest(targetFilePath, configItems);
            } else if (platform === 'wp8') {
                targetFilePath = path.join(platformPath, targetFileName);
                ensureBackup(targetFilePath, platform, targetFileName);
                updateWp8Manifest(targetFilePath, configItems);
            }
        });
    }

    // Script operations are complete, so resolve deferred promises
    function complete(){
        logger.debug("Finished applying platform config");
        deferral.resolve();
    }

    /*************
     * Public API
     *************/

    applyCustomConfig.loadDependencies = function(ctx){
        fs = require('fs-extra'),
            _ = require('lodash'),
            et = require('elementtree'),
            plist = require('plist'),
            xcode = require('xcode'),
            tostr = require('tostr'),
            fileUtils = require(path.resolve(hooksPath, "fileUtils.js"))(ctx);
        logger.debug("Loaded module dependencies");
        applyCustomConfig.init(ctx);
    };

    applyCustomConfig.init = function(ctx){
        context = ctx;
        rootdir = context.opts.projectRoot;

        configXml = fileUtils.getConfigXml();
        projectName = fileUtils.getProjectName();
        settings = fileUtils.getSettings();

        // go through each of the platform directories that have been prepared
        var platforms = _.filter(fs.readdirSync('platforms'), function (file) {
            return fs.statSync(path.resolve('platforms', file)).isDirectory();
        });
        _.each(platforms, function (platform, index) {
            platform = platform.trim().toLowerCase();
            try{
                updatePlatformConfig(platform);
                if(index == platforms.length - 1){
                    complete();
                }
            }catch(e){
                var msg = "Error updating config for platform '"+platform+"': "+ e.message;
                logger.error(msg);
                if(settings.stoponerror){
                    deferral.reject(msg);
                }
            }
        });
    };
    return applyCustomConfig;
})();

// Main
module.exports = function(ctx) {
    deferral = ctx.requireCordovaModule('q').defer();
    path = ctx.requireCordovaModule('path');
    cwd = path.resolve();

    hooksPath = path.resolve(ctx.opts.projectRoot, "plugins", ctx.opts.plugin.id, "hooks");
    logger = require(path.resolve(hooksPath, "logger.js"))(ctx);
    logger.debug("Running applyCustomConfig.js");
    try{
        applyCustomConfig.loadDependencies(ctx);
    }catch(e){
        logger.warn("Error loading dependencies ("+e.message+") - attempting to resolve");
        require(path.resolve(hooksPath, "resolveDependencies.js"))(ctx).then(applyCustomConfig.loadDependencies.bind(this, ctx));
    }

    return deferral.promise;
};
