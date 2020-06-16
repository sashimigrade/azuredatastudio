/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import { FlatFileProvider } from '../services/contracts';
import { ImportDataModel } from './api/models';
import { ImportPage } from './api/importPage';
// pages
import { FileConfigPage } from './pages/fileConfigPage';
import { ProsePreviewPage } from './pages/prosePreviewPage';
import { ModifyColumnsPage } from './pages/modifyColumnsPage';
import { SummaryPage } from './pages/summaryPage';
import { ApiWrapper } from '../common/apiWrapper';
import * as constants from '../common/constants';

export class FlatFileWizard {
	private readonly provider: FlatFileProvider;
	public wizard: azdata.window.Wizard;
	public page1: azdata.window.WizardPage;
	public page2: azdata.window.WizardPage;
	public page3: azdata.window.WizardPage;
	public page4: azdata.window.WizardPage;

	private importAnotherFileButton: azdata.window.Button;

	constructor(
		provider: FlatFileProvider,
		private _apiWrapper: ApiWrapper
	) {
		this.provider = provider;
	}

	public async start(p: any, ...args: any[]) {
		let model = {} as ImportDataModel;

		let profile = p?.connectionProfile as azdata.IConnectionProfile;
		if (profile) {
			model.serverId = profile.id;
			model.database = profile.databaseName;
		}

		let pages: Map<number, ImportPage> = new Map<number, ImportPage>();

		let connectionId: string = await this.getConnectionId();

		if (!connectionId) {
			return;
		}

		model.serverId = connectionId;

		this.wizard = this._apiWrapper.createWizard(constants.wizardNameText);
		this.page1 = this._apiWrapper.createWizardPage(constants.page1NameText);
		this.page2 = this._apiWrapper.createWizardPage(constants.page2NameText);
		this.page3 = this._apiWrapper.createWizardPage(constants.page3NameText);
		this.page4 = this._apiWrapper.createWizardPage(constants.page4NameText);

		let fileConfigPage: FileConfigPage;

		this.page1.registerContent(async (view) => {
			fileConfigPage = new FileConfigPage(this, this.page1, model, view, this.provider, this._apiWrapper);
			pages.set(0, fileConfigPage);
			await fileConfigPage.start().then(() => {
				fileConfigPage.setupNavigationValidator();
				fileConfigPage.onPageEnter();
			});
		});

		let prosePreviewPage: ProsePreviewPage;
		this.page2.registerContent(async (view) => {
			prosePreviewPage = new ProsePreviewPage(this, this.page2, model, view, this.provider, this._apiWrapper);
			pages.set(1, prosePreviewPage);
			await prosePreviewPage.start();
		});

		let modifyColumnsPage: ModifyColumnsPage;
		this.page3.registerContent(async (view) => {
			modifyColumnsPage = new ModifyColumnsPage(this, this.page3, model, view, this.provider, this._apiWrapper);
			pages.set(2, modifyColumnsPage);
			await modifyColumnsPage.start();
		});

		let summaryPage: SummaryPage;

		this.page4.registerContent(async (view) => {
			summaryPage = new SummaryPage(this, this.page4, model, view, this.provider, this._apiWrapper);
			pages.set(3, summaryPage);
			await summaryPage.start();
		});


		this.importAnotherFileButton = this._apiWrapper.createButton(constants.importNewFileText);
		this.importAnotherFileButton.onClick(() => {
			//TODO replace this with proper cleanup for all the pages
			this.wizard.close();
			pages.forEach((page) => page.cleanup());
			this.wizard.open();
		});

		this.importAnotherFileButton.hidden = true;
		this.wizard.customButtons = [this.importAnotherFileButton];
		this.wizard.onPageChanged(async (event) => {
			let newPageIdx = event.newPage;
			let lastPageIdx = event.lastPage;
			let newPage = pages.get(newPageIdx);
			let lastPage = pages.get(lastPageIdx);
			if (lastPage) {
				await lastPage.onPageLeave();
			}
			if (newPage) {
				newPage.setupNavigationValidator();
				await newPage.onPageEnter();
			}
		});

		//not needed for this wizard
		this.wizard.generateScriptButton.hidden = true;

		this.wizard.pages = [this.page1, this.page2, this.page3, this.page4];

		this.wizard.open();
	}

	public async getConnectionId(): Promise<string> {
		let currentConnection = await this._apiWrapper.getCurrentConnection();

		let connectionId: string;

		if (!currentConnection) {
			let connection = await this._apiWrapper.openConnectionDialog(constants.supportedProviders);
			if (!connection) {
				this._apiWrapper.showErrorMessage(constants.needConnectionText);
				return undefined;
			}
			connectionId = connection.connectionId;
		} else {
			if (currentConnection.providerId !== 'MSSQL') {
				this._apiWrapper.showErrorMessage(constants.needSqlConnectionText);
				return undefined;
			}
			connectionId = currentConnection.connectionId;
		}
		return connectionId;
	}

	public setImportAnotherFileVisibility(visibility: boolean) {
		this.importAnotherFileButton.hidden = !visibility;
	}

	public registerNavigationValidator(validator: (pageChangeInfo: azdata.window.WizardPageChangeInfo) => boolean) {
		this.wizard.registerNavigationValidator(validator);
	}

	public changeNextButtonLabel(label: string) {
		this.wizard.nextButton.label = label;
	}


}
