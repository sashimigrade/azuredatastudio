/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISettingsEditorModel, ISetting, ISettingsGroup, ISearchResult, IGroupFilter, SettingMatchType } from 'vs/workbench/services/preferences/common/preferences';
import { IRange } from 'vs/editor/common/core/range';
import { distinct } from 'vs/base/common/arrays';
import * as strings from 'vs/base/common/strings';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IMatch, or, matchesContiguousSubString, matchesPrefix, matchesCamelCase, matchesWords } from 'vs/base/common/filters';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Disposable } from 'vs/base/common/lifecycle';
import { IPreferencesSearchService, ISearchProvider, IWorkbenchSettingsConfiguration } from 'vs/workbench/contrib/preferences/common/preferences';
import { IExtensionManagementService, ILocalExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IWorkbenchExtensionEnablementService } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { CancellationToken } from 'vs/base/common/cancellation';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IProductService } from 'vs/platform/product/common/productService';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';

export interface IEndpointDetails {
	urlBase?: string;
	key?: string;
}

export class PreferencesSearchService extends Disposable implements IPreferencesSearchService {
	declare readonly _serviceBrand: undefined;

	// @ts-expect-error disable remote search for now, ref https://github.com/microsoft/vscode/issues/172411
	private _installedExtensions: Promise<ILocalExtension[]>;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IProductService private readonly productService: IProductService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService
	) {
		super();

		// This request goes to the shared process but results won't change during a window's lifetime, so cache the results.
		this._installedExtensions = this.extensionManagementService.getInstalled(ExtensionType.User).then(exts => {
			// Filter to enabled extensions that have settings
			return exts
				.filter(ext => this.extensionEnablementService.isEnabled(ext))
				.filter(ext => ext.manifest && ext.manifest.contributes && ext.manifest.contributes.configuration)
				.filter(ext => !!ext.identifier.uuid);
		});
	}

	// @ts-expect-error disable remote search for now, ref https://github.com/microsoft/vscode/issues/172411
	private get remoteSearchAllowed(): boolean {
		const workbenchSettings = this.configurationService.getValue<IWorkbenchSettingsConfiguration>().workbench.settings;
		if (!workbenchSettings.enableNaturalLanguageSearch) {
			return false;
		}

		return !!this._endpoint.urlBase;
	}

	private get _endpoint(): IEndpointDetails {
		const workbenchSettings = this.configurationService.getValue<IWorkbenchSettingsConfiguration>().workbench.settings;
		if (workbenchSettings.naturalLanguageSearchEndpoint) {
			return {
				urlBase: workbenchSettings.naturalLanguageSearchEndpoint,
				key: workbenchSettings.naturalLanguageSearchKey
			};
		} else {
			return {
				urlBase: this.productService.settingsSearchUrl
			};
		}
	}

	getRemoteSearchProvider(filter: string, newExtensionsOnly = false): ISearchProvider | undefined {
		// Disable for now because Bing search isn't supported anymore.
		// Ref https://github.com/microsoft/vscode/issues/172411
		return undefined;
	}

	getLocalSearchProvider(filter: string): LocalSearchProvider {
		return this.instantiationService.createInstance(LocalSearchProvider, filter);
	}
}

export class LocalSearchProvider implements ISearchProvider {
	static readonly EXACT_MATCH_SCORE = 10000;
	static readonly START_SCORE = 1000;

	constructor(
		private _filter: string,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		// Remove " and : which are likely to be copypasted as part of a setting name.
		// Leave other special characters which the user might want to search for.
		this._filter = this._filter
			.replace(/[":]/g, ' ')
			.replace(/  /g, ' ')
			.trim();
	}

	searchModel(preferencesModel: ISettingsEditorModel, token?: CancellationToken): Promise<ISearchResult | null> {
		if (!this._filter) {
			return Promise.resolve(null);
		}

		let orderedScore = LocalSearchProvider.START_SCORE; // Sort is not stable
		const settingMatcher = (setting: ISetting) => {
			const { matches, matchType } = new SettingMatches(this._filter, setting, true, true, (filter, setting) => preferencesModel.findValueMatches(filter, setting), this.configurationService);
			const score = this._filter === setting.key ?
				LocalSearchProvider.EXACT_MATCH_SCORE :
				orderedScore--;

			return matches && matches.length ?
				{
					matches,
					matchType,
					score
				} :
				null;
		};

		const filterMatches = preferencesModel.filterSettings(this._filter, this.getGroupFilter(this._filter), settingMatcher);
		if (filterMatches[0] && filterMatches[0].score === LocalSearchProvider.EXACT_MATCH_SCORE) {
			return Promise.resolve({
				filterMatches: filterMatches.slice(0, 1),
				exactMatch: true
			});
		} else {
			return Promise.resolve({
				filterMatches
			});
		}
	}

	private getGroupFilter(filter: string): IGroupFilter {
		const regex = strings.createRegExp(filter, false, { global: true });
		return (group: ISettingsGroup) => {
			return regex.test(group.title);
		};
	}
}

export class SettingMatches {

	private readonly descriptionMatchingWords: Map<string, IRange[]> = new Map<string, IRange[]>();
	private readonly keyMatchingWords: Map<string, IRange[]> = new Map<string, IRange[]>();
	private readonly valueMatchingWords: Map<string, IRange[]> = new Map<string, IRange[]>();

	readonly matches: IRange[];
	matchType: SettingMatchType = SettingMatchType.None;

	constructor(
		searchString: string,
		setting: ISetting,
		private requireFullQueryMatch: boolean,
		private searchDescription: boolean,
		private valuesMatcher: (filter: string, setting: ISetting) => IRange[],
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		this.matches = distinct(this._findMatchesInSetting(searchString, setting), (match) => `${match.startLineNumber}_${match.startColumn}_${match.endLineNumber}_${match.endColumn}_`);
	}

	private _findMatchesInSetting(searchString: string, setting: ISetting): IRange[] {
		const result = this._doFindMatchesInSetting(searchString, setting);
		if (setting.overrides && setting.overrides.length) {
			for (const subSetting of setting.overrides) {
				const subSettingMatches = new SettingMatches(searchString, subSetting, this.requireFullQueryMatch, this.searchDescription, this.valuesMatcher, this.configurationService);
				const words = searchString.split(' ');
				const descriptionRanges: IRange[] = this.getRangesForWords(words, this.descriptionMatchingWords, [subSettingMatches.descriptionMatchingWords, subSettingMatches.keyMatchingWords, subSettingMatches.valueMatchingWords]);
				const keyRanges: IRange[] = this.getRangesForWords(words, this.keyMatchingWords, [subSettingMatches.descriptionMatchingWords, subSettingMatches.keyMatchingWords, subSettingMatches.valueMatchingWords]);
				const subSettingKeyRanges: IRange[] = this.getRangesForWords(words, subSettingMatches.keyMatchingWords, [this.descriptionMatchingWords, this.keyMatchingWords, subSettingMatches.valueMatchingWords]);
				const subSettingValueRanges: IRange[] = this.getRangesForWords(words, subSettingMatches.valueMatchingWords, [this.descriptionMatchingWords, this.keyMatchingWords, subSettingMatches.keyMatchingWords]);
				result.push(...descriptionRanges, ...keyRanges, ...subSettingKeyRanges, ...subSettingValueRanges);
				result.push(...subSettingMatches.matches);
				this.refreshMatchType(keyRanges.length + subSettingKeyRanges.length);
				this.matchType |= subSettingMatches.matchType;
			}
		}
		return result;
	}

	private _doFindMatchesInSetting(searchString: string, setting: ISetting): IRange[] {
		const registry: { [qualifiedKey: string]: IJSONSchema } = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		const schema: IJSONSchema = registry[setting.key];

		const words = searchString.split(' ');
		const settingKeyAsWords: string = setting.key.split('.').join(' ');

		const settingValue = this.configurationService.getValue(setting.key);

		for (const word of words) {
			// Whole word match attempts also take place within this loop.
			if (this.searchDescription) {
				for (let lineIndex = 0; lineIndex < setting.description.length; lineIndex++) {
					const descriptionMatches = matchesWords(word, setting.description[lineIndex], true);
					if (descriptionMatches) {
						this.descriptionMatchingWords.set(word, descriptionMatches.map(match => this.toDescriptionRange(setting, match, lineIndex)));
					}
					this.checkForWholeWordMatchType(word, setting.description[lineIndex]);
				}
			}

			const keyMatches = or(matchesWords, matchesCamelCase)(word, settingKeyAsWords);
			if (keyMatches) {
				this.keyMatchingWords.set(word, keyMatches.map(match => this.toKeyRange(setting, match)));
			}
			this.checkForWholeWordMatchType(word, settingKeyAsWords);

			const valueMatches = typeof settingValue === 'string' ? matchesContiguousSubString(word, settingValue) : null;
			if (valueMatches) {
				this.valueMatchingWords.set(word, valueMatches.map(match => this.toValueRange(setting, match)));
			} else if (schema && schema.enum && schema.enum.some(enumValue => typeof enumValue === 'string' && !!matchesContiguousSubString(word, enumValue))) {
				this.valueMatchingWords.set(word, []);
			}
			if (typeof settingValue === 'string') {
				this.checkForWholeWordMatchType(word, settingValue);
			}
		}

		const descriptionRanges: IRange[] = [];
		if (this.searchDescription) {
			for (let lineIndex = 0; lineIndex < setting.description.length; lineIndex++) {
				const matches = or(matchesContiguousSubString)(searchString, setting.description[lineIndex] || '') || [];
				descriptionRanges.push(...matches.map(match => this.toDescriptionRange(setting, match, lineIndex)));
			}
			if (descriptionRanges.length === 0) {
				descriptionRanges.push(...this.getRangesForWords(words, this.descriptionMatchingWords, [this.keyMatchingWords, this.valueMatchingWords]));
			}
		}

		const keyMatches = or(matchesPrefix, matchesContiguousSubString)(searchString, setting.key);
		const keyRanges: IRange[] = keyMatches ? keyMatches.map(match => this.toKeyRange(setting, match)) : this.getRangesForWords(words, this.keyMatchingWords, [this.descriptionMatchingWords, this.valueMatchingWords]);

		let valueRanges: IRange[] = [];
		if (typeof settingValue === 'string' && settingValue) {
			const valueMatches = or(matchesPrefix, matchesContiguousSubString)(searchString, settingValue);
			valueRanges = valueMatches ? valueMatches.map(match => this.toValueRange(setting, match)) : this.getRangesForWords(words, this.valueMatchingWords, [this.keyMatchingWords, this.descriptionMatchingWords]);
		} else {
			valueRanges = this.valuesMatcher(searchString, setting);
		}

		this.refreshMatchType(keyRanges.length);
		return [...descriptionRanges, ...keyRanges, ...valueRanges];
	}

	private checkForWholeWordMatchType(singleWordQuery: string, lineToSearch: string) {
		// Trim excess ending characters off the query.
		singleWordQuery = singleWordQuery.toLowerCase().replace(/[\s-\._]+$/, '');
		lineToSearch = lineToSearch.toLowerCase();
		const singleWordRegex = new RegExp(`\\b${strings.escapeRegExpCharacters(singleWordQuery)}\\b`);
		if (singleWordRegex.test(lineToSearch)) {
			this.matchType |= SettingMatchType.WholeWordMatch;
		}
	}

	private refreshMatchType(keyRangesLength: number) {
		if (keyRangesLength) {
			this.matchType |= SettingMatchType.KeyMatch;
		}
	}

	private getRangesForWords(words: string[], from: Map<string, IRange[]>, others: Map<string, IRange[]>[]): IRange[] {
		const result: IRange[] = [];
		for (const word of words) {
			const ranges = from.get(word);
			if (ranges) {
				result.push(...ranges);
			} else if (this.requireFullQueryMatch && others.every(o => !o.has(word))) {
				return [];
			}
		}
		return result;
	}

	private toKeyRange(setting: ISetting, match: IMatch): IRange {
		return {
			startLineNumber: setting.keyRange.startLineNumber,
			startColumn: setting.keyRange.startColumn + match.start,
			endLineNumber: setting.keyRange.startLineNumber,
			endColumn: setting.keyRange.startColumn + match.end
		};
	}

	private toDescriptionRange(setting: ISetting, match: IMatch, lineIndex: number): IRange {
		return {
			startLineNumber: setting.descriptionRanges[lineIndex].startLineNumber,
			startColumn: setting.descriptionRanges[lineIndex].startColumn + match.start,
			endLineNumber: setting.descriptionRanges[lineIndex].endLineNumber,
			endColumn: setting.descriptionRanges[lineIndex].startColumn + match.end
		};
	}

	private toValueRange(setting: ISetting, match: IMatch): IRange {
		return {
			startLineNumber: setting.valueRange.startLineNumber,
			startColumn: setting.valueRange.startColumn + match.start + 1,
			endLineNumber: setting.valueRange.startLineNumber,
			endColumn: setting.valueRange.startColumn + match.end + 1
		};
	}
}

registerSingleton(IPreferencesSearchService, PreferencesSearchService, InstantiationType.Delayed);
